use super::*;
use sha3::{Digest, Sha3_256};

#[derive(Debug, PartialEq, Copy, Clone)]
enum Curse {
  DuplicateField,
  IncompleteField,
  NotAtOffsetZero,
  NotInFirstInput,
  Pointer,
  Pushnum,
  Reinscription,
  Stutter,
  UnrecognizedEvenField,
}

#[derive(Debug, Clone)]
pub(super) struct Flotsam<'a> {
  inscription_id: InscriptionId,
  offset: u64,
  origin: Origin,
  tx_option: Option<&'a Transaction>,
}

#[derive(Debug, Clone)]
enum Origin {
  New {
    cursed: bool,
    fee: u64,
    hidden: bool,
    parents: Vec<InscriptionId>,
    pointer: Option<u64>,
    reinscription: bool,
    unbound: bool,
    vindicated: bool,
  },
  Old {
    old_satpoint: SatPoint,
  },
}

lazy_static! {
  pub static ref TX_LIMITS: HashMap<String, i16> = {
    let mut m = HashMap::<String, i16>::new();
    m.insert("default".into(), 2);
    m
  };
}

pub(super) struct InscriptionUpdater<'a, 'tx> {
  pub(super) blessed_inscription_count: u64,
  pub(super) chain: Chain,
  pub(super) content_type_to_count: &'a mut Table<'tx, Option<&'static [u8]>, u64>,
  pub(super) cursed_inscription_count: u64,
  pub(super) event_sender: Option<&'a Sender<Event>>,
  pub(super) flotsam: Vec<Flotsam<'a>>,
  pub(super) height: u32,
  pub(super) home_inscription_count: u64,
  pub(super) home_inscriptions: &'a mut Table<'tx, u32, InscriptionIdValue>,
  pub(super) id_to_sequence_number: &'a mut Table<'tx, InscriptionIdValue, u32>,
  pub(super) index_transactions: bool,
  pub(super) inscription_number_to_sequence_number: &'a mut Table<'tx, i32, u32>,
  pub(super) lost_sats: u64,
  pub(super) next_sequence_number: u32,
  pub(super) outpoint_to_value: &'a mut Table<'tx, &'static OutPointValue, u64>,
  pub(super) reward: u64,
  pub(super) transaction_buffer: Vec<u8>,
  pub(super) transaction_id_to_transaction: &'a mut Table<'tx, &'static TxidValue, &'static [u8]>,
  pub(super) sat_to_sequence_number: &'a mut MultimapTable<'tx, u64, u32>,
  pub(super) satpoint_to_sequence_number: &'a mut MultimapTable<'tx, &'static SatPointValue, u32>,
  pub(super) sequence_number_to_children: &'a mut MultimapTable<'tx, u32, u32>,
  pub(super) sequence_number_to_entry: &'a mut Table<'tx, u32, InscriptionEntryValue>,
  pub(super) sequence_number_to_satpoint: &'a mut Table<'tx, u32, &'static SatPointValue>,
  pub(super) timestamp: u32,
  pub(super) unbound_inscriptions: u64,
  pub(super) value_cache: &'a mut HashMap<OutPoint, u64>,
  pub(super) value_receiver: &'a mut Receiver<u64>,
  pub(super) first_in_block: bool,
}

use hex;
use serde_json::Value;
use std::env;
use std::fs::{File, OpenOptions};

impl<'a, 'tx> InscriptionUpdater<'a, 'tx> {
  
  pub(super) fn index_inscriptions(
    &mut self,
    tx: &'a Transaction,
    txid: Txid,
    input_sat_ranges: Option<&VecDeque<(u64, u64)>>,
  ) -> Result {


    let mut floating_inscriptions = Vec::new();
    let mut id_counter = 0;
    let mut inscribed_offsets = BTreeMap::new();
    let jubilant = self.height >= self.chain.jubilee_height();
    let mut total_input_value = 0;
    let total_output_value = tx.output.iter().map(|txout| txout.value).sum::<u64>();

    let envelopes = ParsedEnvelope::from_transaction(tx);
    let inscriptions = !envelopes.is_empty();
    let mut envelopes = envelopes.into_iter().peekable();

    for (input_index, tx_in) in tx.input.iter().enumerate() {
      // skip subsidy since no inscriptions possible
      if tx_in.previous_output.is_null() {
        total_input_value += Height(self.height).subsidy();
        
        continue;
      }

      // find existing inscriptions on input (transfers of inscriptions)
      for (old_satpoint, inscription_id) in Index::inscriptions_on_output(
        self.satpoint_to_sequence_number,
        self.sequence_number_to_entry,
        tx_in.previous_output,
      )? {
        let offset = total_input_value + old_satpoint.offset;

        floating_inscriptions.push(Flotsam {
          offset,
          inscription_id,
          origin: Origin::Old { old_satpoint },
          tx_option: Some(&tx),
        });

        inscribed_offsets
          .entry(offset)
          .or_insert((inscription_id, 0))
          .1 += 1;
      }

      let offset = total_input_value;

      // multi-level cache for UTXO set to get to the input amount
      let current_input_value = if let Some(value) = self.value_cache.remove(&tx_in.previous_output)
      {
        value
      } else if let Some(value) = self
        .outpoint_to_value
        .remove(&tx_in.previous_output.store())?
      {
        value.value()
      } else {
        self.value_receiver.blocking_recv().ok_or_else(|| {
          anyhow!(
            "failed to get transaction for {}",
            tx_in.previous_output.txid
          )
        })?
      };

      total_input_value += current_input_value;

      // go through all inscriptions in this input
      while let Some(inscription) = envelopes.peek() {
        if inscription.input != u32::try_from(input_index).unwrap() {
          break;
        }

        let inscription_id = InscriptionId {
          txid,
          index: id_counter,
        };

        let curse = if inscription.payload.unrecognized_even_field {
          Some(Curse::UnrecognizedEvenField)
        } else if inscription.payload.duplicate_field {
          Some(Curse::DuplicateField)
        } else if inscription.payload.incomplete_field {
          Some(Curse::IncompleteField)
        } else if inscription.input != 0 {
          Some(Curse::NotInFirstInput)
        } else if inscription.offset != 0 {
          Some(Curse::NotAtOffsetZero)
        } else if inscription.payload.pointer.is_some() {
          Some(Curse::Pointer)
        } else if inscription.pushnum {
          Some(Curse::Pushnum)
        } else if inscription.stutter {
          Some(Curse::Stutter)
        } else if let Some((id, count)) = inscribed_offsets.get(&offset) {
          if *count > 1 {
            Some(Curse::Reinscription)
          } else {
            let initial_inscription_sequence_number =
              self.id_to_sequence_number.get(id.store())?.unwrap().value();

            let entry = InscriptionEntry::load(
              self
                .sequence_number_to_entry
                .get(initial_inscription_sequence_number)?
                .unwrap()
                .value(),
            );

            let initial_inscription_was_cursed_or_vindicated =
              entry.inscription_number < 0 || Charm::Vindicated.is_set(entry.charms);

            if initial_inscription_was_cursed_or_vindicated {
              None
            } else {
              Some(Curse::Reinscription)
            }
          }
        } else {
          None
        };

        let offset = inscription
          .payload
          .pointer()
          .filter(|&pointer| pointer < total_output_value)
          .unwrap_or(offset);

        let content_type = inscription.payload.content_type.as_deref();

        let content_type_count = self
          .content_type_to_count
          .get(content_type)?
          .map(|entry| entry.value())
          .unwrap_or_default();

        self
          .content_type_to_count
          .insert(content_type, content_type_count + 1)?;

        floating_inscriptions.push(Flotsam {
          inscription_id,
          offset,
          origin: Origin::New {
            cursed: curse.is_some() && !jubilant,
            fee: 0,
            hidden: inscription.payload.hidden(),
            parents: inscription.payload.parents(),
            pointer: inscription.payload.pointer(),
            reinscription: inscribed_offsets.contains_key(&offset),
            unbound: current_input_value == 0
              || curse == Some(Curse::UnrecognizedEvenField)
              || inscription.payload.unrecognized_even_field,
            vindicated: curse.is_some() && jubilant,
          },
          tx_option: Some(&tx)
        });

        inscribed_offsets
          .entry(offset)
          .or_insert((inscription_id, 0))
          .1 += 1;

        envelopes.next();
        id_counter += 1;
      }
    }

    if self.index_transactions && inscriptions {
      tx.consensus_encode(&mut self.transaction_buffer)
        .expect("in-memory writers don't error");

      self
        .transaction_id_to_transaction
        .insert(&txid.store(), self.transaction_buffer.as_slice())?;

      self.transaction_buffer.clear();
    }

    let potential_parents = floating_inscriptions
      .iter()
      .map(|flotsam| flotsam.inscription_id)
      .collect::<HashSet<InscriptionId>>();

    for flotsam in &mut floating_inscriptions {
      if let Flotsam {
        origin: Origin::New {
          parents: purported_parents,
          ..
        },
        ..
      } = flotsam
      {
        let mut seen = HashSet::new();
        purported_parents
          .retain(|parent| seen.insert(*parent) && potential_parents.contains(parent));
      }
    }

    // still have to normalize over inscription size
    for flotsam in &mut floating_inscriptions {
      if let Flotsam {
        origin: Origin::New { ref mut fee, .. },
        ..
      } = flotsam
      {
        *fee = (total_input_value - total_output_value) / u64::from(id_counter);
      }
    }

    let is_coinbase = tx
      .input
      .first()
      .map(|tx_in| tx_in.previous_output.is_null())
      .unwrap_or_default();

    let own_inscription_cnt = floating_inscriptions.len();   
     if is_coinbase {
      floating_inscriptions.append(&mut self.flotsam);
    }

    floating_inscriptions.sort_by_key(|flotsam| flotsam.offset);
    let mut inscriptions = floating_inscriptions.into_iter().peekable();

    let mut range_to_vout = BTreeMap::new();
    let mut new_locations = Vec::new();

    let mut output_value = 0;
    let mut inscription_idx = 0;
    for (vout, tx_out) in tx.output.iter().enumerate() {
      let end = output_value + tx_out.value;

      while let Some(flotsam) = inscriptions.peek() {
        if flotsam.offset >= end {
          break;
        }

        let sent_to_coinbase = inscription_idx >= own_inscription_cnt;
        inscription_idx += 1;

        let new_satpoint = SatPoint {
          outpoint: OutPoint {
            txid,
            vout: vout.try_into().unwrap(),
          },
          offset: flotsam.offset - output_value,
        };
        new_locations.push((new_satpoint, sent_to_coinbase, tx_out, inscriptions.next().unwrap()));
      }

      range_to_vout.insert((output_value, end), vout.try_into().unwrap());

      output_value = end;

      self.value_cache.insert(
        OutPoint {
          vout: vout.try_into().unwrap(),
          txid,
        },
        tx_out.value,
      );
    }


    for (new_satpoint, sent_to_coinbase, tx_out, mut flotsam) in new_locations.into_iter() {
      let new_satpoint = match flotsam.origin {
        Origin::New {
          pointer: Some(pointer),
          ..
        } if pointer < output_value => {
          match range_to_vout.iter().find_map(|((start, end), vout)| {
            (pointer >= *start && pointer < *end).then(|| (vout, pointer - start))
          }) {
            Some((vout, offset)) => {
              flotsam.offset = pointer;
              SatPoint {
                outpoint: OutPoint { txid, vout: *vout },
                offset,
              }
            }
            _ => new_satpoint,
          }
        }
        _ => new_satpoint,
      };

   let tx = flotsam.tx_option.clone().unwrap();
      self.update_inscription_location(
        Some(&tx),
        Some(&tx_out.script_pubkey),
        Some(&tx_out.value),
        input_sat_ranges,
        flotsam,
        new_satpoint,
        sent_to_coinbase,
      )?;
    }

    if is_coinbase {
      for flotsam in inscriptions {
        let new_satpoint = SatPoint {
          outpoint: OutPoint::null(),
          offset: self.lost_sats + flotsam.offset - output_value,
        };

           let tx = flotsam.tx_option.clone().unwrap();
        self.update_inscription_location(
          Some(&tx),
          None,
          None,
          input_sat_ranges,
          flotsam,
          new_satpoint,
          true,
        )?;
      }
      self.lost_sats += self.reward - output_value;
      Ok(())
    } else {
    for flotsam in inscriptions {
        self.flotsam.push(Flotsam {
            offset: self.reward + flotsam.offset - output_value,
            ..flotsam
        });

        // ord indexes sent as fee transfers at the end of the block but it would make more sense if they were indexed as soon as they are sent
        self.write_to_file(
            format!("cmd;{0};insert;early_transfer_sent_as_fee;{1}", self.height, flotsam.inscription_id), 
            true
        )?;
    }
    self.reward += total_input_value - output_value;
    Ok(())
  }
}

  fn calculate_sat(
    input_sat_ranges: Option<&VecDeque<(u64, u64)>>,
    input_offset: u64,
  ) -> Option<Sat> {
    let input_sat_ranges = input_sat_ranges?;

    let mut offset = 0;
    for (start, end) in input_sat_ranges {
      let size = end - start;
      if offset + size > input_offset {
        let n = start + input_offset - offset;
        return Some(Sat(n));
      }
      offset += size;
    }

    unreachable!()
  }

  fn get_json_tx_limit(inscription_content_option: &Option<Vec<u8>>) -> i16 {
    if inscription_content_option.is_none() {
      return 0;
    }
    let inscription_content = inscription_content_option.as_ref().unwrap();

    let json = serde_json::from_slice::<Value>(&inscription_content);
    if json.is_err() {
      return 0;
    } else {
      // check for event type and return tx limit
      return TX_LIMITS["default"];
    }
  }

  fn is_text(inscription_content_type_option: &Option<Vec<u8>>) -> bool {
    if inscription_content_type_option.is_none() {
      return false;
    }

    let inscription_content_type = inscription_content_type_option.as_ref().unwrap();
    let inscription_content_type_str = std::str::from_utf8(&inscription_content_type).unwrap_or("");
    return inscription_content_type_str == "text/plain"
      || inscription_content_type_str.starts_with("text/plain;")
      || inscription_content_type_str == "application/json"
      || inscription_content_type_str.starts_with("application/json;"); // NOTE: added application/json for JSON5 etc.
  }
fn write_to_file(&mut self, to_write: String, flush: bool) -> Result {
    lazy_static! {
      static ref INSCRIPTIONS: Mutex<Option<File>> = Mutex::new(None);
    }
    let mut inscriptions = INSCRIPTIONS.lock().unwrap();
    if inscriptions.as_ref().is_none() {
      let chain_folder: String = match self.chain {
        Chain::Mainnet => String::from("mainnet/"),
        Chain::Testnet => String::from("testnet3/"),
        Chain::Signet => String::from("signet/"),
        Chain::Regtest => String::from("regtest/"),
      };

       let current_dir = env::current_dir().unwrap();
    let file_path = current_dir.join(format!("{}inscriptions.txt", chain_folder));


    // Check if the file exists, create if not, and then open for appending
    let file = OpenOptions::new()
        .create(true)  // Create the file if it doesn't exist
        .append(true)  // Open for appending
        .open(&file_path)
        .unwrap();

    *inscriptions = Some(file);
    }
    if to_write != "" {
      if self.first_in_block {
        // println!("cmd;{0};block_start", self.height);
        writeln!(
          inscriptions.as_ref().unwrap(),
          "cmd~||~{0}~||~block_start",
          self.height,
        )?;
      }
      self.first_in_block = false;

      writeln!(inscriptions.as_ref().unwrap(), "{}", to_write)?;
    }
    if flush {
      (inscriptions.as_ref().unwrap()).flush()?;
    }

    Ok(())
  }
  pub(super) fn end_block(&mut self) -> Result {
    if !self.first_in_block {
      println!("cmd~||~{0}~||~block_end", self.height);
      self.write_to_file(format!("cmd~||~{0}~||~block_end", self.height), true)?;
    }

    Ok(())
  }
  fn update_inscription_location(
    &mut self,
    tx_option: Option<&Transaction>,
    new_script_pubkey: Option<&ScriptBuf>,
    new_output_value: Option<&u64>,
    input_sat_ranges: Option<&VecDeque<(u64, u64)>>,
    flotsam: Flotsam,
    new_satpoint: SatPoint,
    send_to_coinbase: bool,
  ) -> Result {
    let tx = tx_option.unwrap();
    let inscription_id = flotsam.inscription_id;
    let (unbound, sequence_number) = match flotsam.origin {
      Origin::Old { old_satpoint } => {
        self
          .satpoint_to_sequence_number
          .remove_all(&old_satpoint.store())?;

        let sequence_number = self
          .id_to_sequence_number
          .get(&inscription_id.store())?
          .unwrap()
          .value();

        self.write_to_file(
    format!(
        "cmd~||~height:{}~||~insert~||~transfer~||~inscription_id:{}~||~old_location:{old_satpoint}~||~new_location:{new_satpoint}~||~sent_as_fee:{send_to_coinbase}~||~new_pubkey:{}~||~new_output_value:{}~||~new_address:{:?}~||~timestamp:{:?}",
        self.height,
        flotsam.inscription_id,
        hex::encode(
            new_script_pubkey
                .unwrap_or(&ScriptBuf::new())  // Provide a default empty script if none
                .clone()
                .into_bytes()
        ),
        new_output_value.unwrap_or(&0),  // Provide a default output value of 0 if none
        new_script_pubkey
            .and_then(|script| Some(self.chain.address_from_script(script)))  // Convert script to address
            .map_or_else(
                || "Invalid script".to_string(),
                |result| result
                    .map(|address| format!("{:?}", address))  // Use Debug formatting for NetworkUnchecked address
                    .unwrap_or_else(|_| "Invalid address".to_string())
            ), self.timestamp
    ), 
    false,
)?;

        // self.write_to_file(
        //         format!(
        //             "InscriptionTransferred;block_height={};inscription_id={};new_location={};old_location={};sequence_number={}",
        //             self.height, inscription_id, new_satpoint, old_satpoint, sequence_number
        //         ),
        //         true,
        //     )?;

        if let Some(sender) = self.event_sender {
          sender.blocking_send(Event::InscriptionTransferred {
            block_height: self.height,
            inscription_id,
            new_location: new_satpoint,
            old_location: old_satpoint,
            sequence_number,
          })?;
        }

        (false, sequence_number)
      }
      Origin::New {
        cursed,
        fee,
        hidden,
        parents,
        pointer: _,
        reinscription,
        unbound,
        vindicated,
      } => {
        let inscription_number = if cursed {
          let number: i32 = self.cursed_inscription_count.try_into().unwrap();
          self.cursed_inscription_count += 1;
          -(number + 1)
        } else {
          let number: i32 = self.blessed_inscription_count.try_into().unwrap();
          self.blessed_inscription_count += 1;
          number
        };

        let sequence_number = self.next_sequence_number;
        self.next_sequence_number += 1;

        self
          .inscription_number_to_sequence_number
          .insert(inscription_number, sequence_number)?;

        // println!("Transaction detail: {:?}      Inscription number: {}", tx.txid(), inscription_number);

        let inscription = ParsedEnvelope::from_transaction(&tx)
          .get(flotsam.inscription_id.index as usize)
          .unwrap()
          .payload
          .clone();



        let rune = inscription.rune.as_ref();
        let delegate = inscription.delegate();
        let metadata = inscription.metadata();// inscription.metadata.as_ref().map(|v| String::from_utf8_lossy(v));
        let timestamp = self.timestamp;
        let inscription_content = inscription.body;
        let inscription_content_type = inscription.content_type;
        let inscription_metaprotocol = inscription.metaprotocol;
        let json_txcnt_limit = Self::get_json_tx_limit(&inscription_content);
        let is_json = json_txcnt_limit > 0;
        let is_text = Self::is_text(&inscription_content_type);
        let is_json_or_text = is_json || is_text;

        let sat = if unbound {
          None
        } else {
          Self::calculate_sat(input_sat_ranges, flotsam.offset)
        };

        let mut charms = 0;

        if cursed {
          Charm::Cursed.set(&mut charms);
        }

        if reinscription {
          Charm::Reinscription.set(&mut charms);
        }

        if let Some(sat) = sat {
          charms |= sat.charms();
        }

        if new_satpoint.outpoint == OutPoint::null() {
          Charm::Lost.set(&mut charms);
        }

        if unbound {
          Charm::Unbound.set(&mut charms);
        }

        if vindicated {
          Charm::Vindicated.set(&mut charms);
        }

        if let Some(Sat(n)) = sat {
          self.sat_to_sequence_number.insert(&n, &sequence_number)?;
        }

        let parent_sequence_numbers = parents
          .iter()
          .map(|parent| {
            let parent_sequence_number = self
              .id_to_sequence_number
              .get(&parent.store())?
              .unwrap()
              .value();

            self
              .sequence_number_to_children
              .insert(parent_sequence_number, sequence_number)?;

            Ok(parent_sequence_number)
          })
          .collect::<Result<Vec<u32>>>()?;

        // Define a set of resource-intensive content types
        let resource_intensive_types: HashSet<&str> = [
          "video/mp4",
          "video/mpeg",
          "audio/mpeg",
          "audio/wav",
          "audio/ogg",
          // Add other content types you want to exclude
        ]
        .iter()
        .cloned()
        .collect();

        // Convert the content type to a string, assuming it's valid UTF-8
        let inscription_content_type_str =
          String::from_utf8(inscription_content_type.unwrap_or(Vec::new()))
            .unwrap_or_else(|_| String::from(""));

        // Convert the metaprotocol to a string, assuming it's valid UTF-8
        let inscription_metaprotocol_str =
          String::from_utf8(inscription_metaprotocol.unwrap_or(Vec::new()))
            .unwrap_or_else(|_| String::from(""));

        // Declare `sha3_256_hash` outside of the if-else block, initialized as `None`
        let mut sha3_256_hash: Option<String> = None;

        // Borrow `inscription_content` to avoid moving it
        let mut inscription_content_byte = inscription_content
          .as_ref()
          .map_or(Vec::new(), |v| v.clone());

        // Check if the content type is UTF-8 based
        if inscription_content_type_str.contains("utf-8") || inscription_content_type_str.contains("text") {
            // Convert the byte content to a string, remove spaces and newlines, then convert back to bytes
            if let Ok(mut content_str) = String::from_utf8(inscription_content_byte.clone()) {
                content_str = content_str.replace(|c: char| c.is_whitespace(), "");
                inscription_content_byte = content_str.into_bytes();
            }
        }

        // Check if the content type is resource-intensive
        if resource_intensive_types.contains(inscription_content_type_str.as_str()) {
          // println!(
          //   "Content type {} is resource-intensive, skipping hash calculation.",
          //   inscription_content_type_str
          // );
        } else {
          // Compute the SHA3-256 hash for `inscription_content`
          let mut hasher = Sha3_256::new();
          hasher.update(&inscription_content_byte);
          let result = hasher.finalize();
          sha3_256_hash = Some(format!("{:x}", result)); // Convert the hash to a hex string
        }
        let _txcnt_limit = if !unbound && is_json_or_text {
          // self.write_to_file(
          //   format!(
          //     "cmd~||~{0}~||~insert~||~number_to_id~||~{1}~||~{2}~||~{3}",
          //     self.height,
          //     inscription_number,
          //     flotsam.inscription_id,
          //     parents
          //       .iter()
          //       .map(|p| p.to_string())
          //       .collect::<Vec<_>>()
          //       .join(",")
          //   ),
          //   false,
          // )?;

          // write content as minified json
          if is_json {
            let inscription_content_json =
              serde_json::from_slice::<Value>(&(inscription_content.unwrap())).unwrap();
            let inscription_content_json_str =
              serde_json::to_string(&inscription_content_json).unwrap();

            self.write_to_file(
              format!(
                "cmd~||~height:{}~||~insert~||~content~||~inscription_number:{}~||~inscription_id:{}~||~is_json:{}~||~content_type:{}~||~metaprotocol:{}~||~content_json:{}~||~parents:{}~||~sat:{:?}~||~timestamp:{}~||~location:{:?}~||~charms:{}~||~output_value:{}~||~address:{:?}~||~delegate:{:?}~||~sha:{:?}~||~rune:{:?}~||~metadata:{:?}",
                self.height,
                inscription_number,
                flotsam.inscription_id,
                is_json,
                inscription_content_type_str,
                inscription_metaprotocol_str,
                inscription_content_json_str,
                parents
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(","),sat.unwrap(), timestamp,(!unbound).then_some(new_satpoint), charms, new_output_value.unwrap_or(&0),  // Provide a default output value of 0 if none
        new_script_pubkey
            .and_then(|script| Some(self.chain.address_from_script(script)))  // Convert script to address
            .map_or_else(
                || "Invalid script".to_string(),
                |result| result
                    .map(|address| format!("{:?}", address))  // Use Debug formatting for NetworkUnchecked address
                    .unwrap_or_else(|_| "Invalid address".to_string())
            ), delegate,
             sha3_256_hash.unwrap_or_else(|| "".to_string()),
             rune,  match &metadata {
            Some(meta) => format!("{:?}", meta), // Convert metadata to string if available
            None => "".to_string(), // Handle the case where metadata is None
        }
              ),
              false,
            )?;

            json_txcnt_limit
          } else {
            let inscription_content_str = String::from_utf8(inscription_content.unwrap_or(Vec::new()))
    .unwrap_or_else(|_| String::from(""))
    .replace(|c: char| c.is_whitespace(), "");


            self.write_to_file(
              format!(
                "cmd~||~height:{}~||~insert~||~content~||~inscription_number:{}~||~inscription_id:{}~||~is_json:{}~||~content_type:{}~||~metaprotocol:{}~||~content:{}~||~parents:{}~||~sat:{:?}~||~timestamp:{}~||~location:{:?}~||~charms:{}~||~output_value:{}~||~address:{:?}~||~delegate:{:?}~||~sha:{:?}~||~rune:{:?}~||~metadata:{:?}",
                self.height,
                inscription_number,
                flotsam.inscription_id,
                is_json,
                inscription_content_type_str,
                inscription_metaprotocol_str,
                inscription_content_str,
                parents
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(","),
                sat, timestamp,(!unbound).then_some(new_satpoint), charms, new_output_value.unwrap_or(&0),  // Provide a default output value of 0 if none
        new_script_pubkey
            .and_then(|script| Some(self.chain.address_from_script(script)))  // Convert script to address
            .map_or_else(
                || "Invalid script".to_string(),
                |result| result
                    .map(|address| format!("{:?}", address))  // Use Debug formatting for NetworkUnchecked address
                    .unwrap_or_else(|_| "Invalid address".to_string())
            ), delegate,
             sha3_256_hash.unwrap_or_else(|| "".to_string()),
             rune,  match &metadata {
            Some(meta) => format!("{:?}", meta), // Convert metadata to string if available
            None => "".to_string(), // Handle the case where metadata is None
        }
              ),
              false,
            )?;

            TX_LIMITS["default"]
          }
        } else {
          self.write_to_file(
            format!(
              "cmd~||~{0}~||~insert~||~number_to_id~||~{1}~||~{2}~||~{3}",
              self.height,
              inscription_number,
              flotsam.inscription_id,
              parents
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(",")
            ),
            false,
          )?;

          let inscription_content_str =
            String::from_utf8(inscription_content.unwrap_or(Vec::new()))
              .unwrap_or_else(|_| String::from(""));

          // let inscription_content_type_str =
          //   String::from_utf8(inscription_content_type.unwrap_or(Vec::new()))
          //     .unwrap_or_else(|_| String::from("Invalid UTF-8"));

          // let inscription_metaprotocol_str =
          //   String::from_utf8(inscription_metaprotocol.unwrap_or(Vec::new()))
          //     .unwrap_or_else(|_| String::from("Invalid UTF-8"));
          self.write_to_file(
              format!(
                "cmd~||~height:{}~||~insert~||~content~||~inscription_number:{}~||~inscription_id:{}~||~is_json:{}~||~content_type:{}~||~metaprotocol:{}~||~content:{:?}~||~parents:{}~||~sat:{:?}~||~timestamp:{}~||~location:{:?}~||~charms:{}~||~output_value:{:?}~||~address:{:?}~||~delegate:{:?}~||~sha:{:?}~||~rune:{:?}~||~metadata:{:?}",
                self.height,
                inscription_number,
                flotsam.inscription_id,
                is_json,
                inscription_content_type_str,
                inscription_metaprotocol_str,
                inscription_content_str,
                parents
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(","),
               match sat {
    Some(value) => value,
    None => {
        eprintln!("Warning: sat is None");
        ordinals::Sat(0) // Create a new Sat with value 0
    }
},
                 timestamp,
                 (!unbound).then_some(new_satpoint),
                  charms,
                   new_output_value.unwrap_or(&0),  // Provide a default output value of 0 if none
        new_script_pubkey
            .and_then(|script| Some(self.chain.address_from_script(script)))  // Convert script to address
            .map_or_else(
                || "Invalid script".to_string(),
                |result| result
                    .map(|address| format!("{:?}", address))  // Use Debug formatting for NetworkUnchecked address
                    .unwrap_or_else(|_| "Invalid address".to_string())
            ), delegate,
             sha3_256_hash.unwrap_or_else(|| "".to_string()),
             rune,  match &metadata {
            Some(meta) => format!("{:?}", meta), // Convert metadata to string if available
            None => "".to_string(), // Handle the case where metadata is None
        }
              ),
              false,
            )?;
          0
        };

        if let Some(sender) = self.event_sender {
          sender.blocking_send(Event::InscriptionCreated {
            block_height: self.height,
            charms,
            inscription_id,
            location: (!unbound).then_some(new_satpoint),
            parent_inscription_ids: parents,
            sequence_number,
          })?;
        }

        self.sequence_number_to_entry.insert(
          sequence_number,
          &InscriptionEntry {
            charms,
            fee,
            height: self.height,
            id: inscription_id,
            inscription_number,
            parents: parent_sequence_numbers,
            sat,
            sequence_number,
            timestamp: self.timestamp,
          }
          .store(),
        )?;

        self
          .id_to_sequence_number
          .insert(&inscription_id.store(), sequence_number)?;

        if !hidden {
          self
            .home_inscriptions
            .insert(&sequence_number, inscription_id.store())?;

          if self.home_inscription_count == 100 {
            self.home_inscriptions.pop_first()?;
          } else {
            self.home_inscription_count += 1;
          }
        }

        (unbound, sequence_number)
      }
    };

    let satpoint = if unbound {
      let new_unbound_satpoint = SatPoint {
        outpoint: unbound_outpoint(),
        offset: self.unbound_inscriptions,
      };
      self.unbound_inscriptions += 1;
      new_unbound_satpoint.store()
    } else {
      new_satpoint.store()
    };

    self
      .satpoint_to_sequence_number
      .insert(&satpoint, sequence_number)?;
    self
      .sequence_number_to_satpoint
      .insert(sequence_number, &satpoint)?;

    self.write_to_file("".to_string(), true)?;

    Ok(())
  }
}
