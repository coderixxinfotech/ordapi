use super::*;
use std::result::Result;
pub trait OptionExt<T> {
  fn ok_or_not_found<F, E>(self, err: F) -> Result<T, E>
  where
    F: FnOnce() -> E;
}

impl<T> OptionExt<T> for Option<T> {
  fn ok_or_not_found<F, E>(self, err: F) -> Result<T, E>
  where
    F: FnOnce() -> E,
  {
    match self {
      Some(value) => Ok(value),
      None => Err(err()),
    }
  }
}

#[derive(Boilerplate, Default)]
pub(crate) struct InscriptionHtml {
  pub(crate) chain: Chain,
  pub(crate) children: Vec<InscriptionId>,
  pub(crate) genesis_fee: u64,
  pub(crate) genesis_height: u32,
  pub(crate) inscription: Inscription,
  pub(crate) inscription_id: InscriptionId,
  pub(crate) inscription_number: i32,
  pub(crate) next: Option<InscriptionId>,
  pub(crate) output: Option<TxOut>,
  pub(crate) parent: Option<InscriptionId>,
  pub(crate) previous: Option<InscriptionId>,
  pub(crate) rune: Option<Rune>,
  pub(crate) sat: Option<Sat>,
  pub(crate) satpoint: SatPoint,
  pub(crate) timestamp: DateTime<Utc>,
  pub(crate) charms: u16,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct ExtendedInscriptionJson {
  pub address: Option<String>,
  pub children: Vec<InscriptionId>,
  pub content_length: Option<usize>,
  pub content_type: Option<String>,
  pub genesis_fee: u64,
  pub genesis_height: u32,
  pub inscription_id: InscriptionId,
  pub inscription_number: i32,
  pub next: Option<InscriptionId>,
  pub output_value: Option<u64>,
  pub parent: Option<InscriptionId>,
  pub previous: Option<InscriptionId>,
  pub rune: Option<Rune>,
  pub sat: Option<Sat>,
  pub satpoint: SatPoint,
  pub timestamp: i64,
  pub metaprotocol: Option<String>,
  pub metadata: Option<Value>,
  pub(crate) charms: u16,

  // added
  pub genesis_transaction: Txid,
  pub output: OutPoint,
  pub location: SatPoint,
  pub offset: u64,

  // Fields from SatJson
  pub decimal: Option<String>,
  pub degree: Option<String>,
  pub sat_name: Option<String>,
  pub block: Option<u32>,
  pub cycle: Option<u32>,
  pub epoch: Option<u32>,
  pub period: Option<u32>,
  pub sat_offset: Option<u64>,
  pub rarity: Option<Rarity>,
  pub percentile: Option<String>,
  pub sat_timestamp: Option<i64>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct InscriptionJson {
  pub address: Option<String>,
  pub children: Vec<InscriptionId>,
  pub content_length: Option<usize>,
  pub content_type: Option<String>,
  pub genesis_fee: u64,
  pub genesis_height: u32,
  pub inscription_id: InscriptionId,
  pub inscription_number: i32,
  pub next: Option<InscriptionId>,
  pub output_value: Option<u64>,
  pub parent: Option<InscriptionId>,
  pub previous: Option<InscriptionId>,
  pub rune: Option<Rune>,
  pub sat: Option<Sat>,
  pub satpoint: SatPoint,
  pub timestamp: i64,
}

#[derive(Serialize, Deserialize, Debug)]
struct InputJson {
  previous_output: String,
  address: Option<String>,
  value: Option<u64>,
}

// Tx api_function
#[derive(Serialize, PartialEq, Deserialize)]
struct OutputJson {
  value: u64, // or the appropriate type
  script_pubkey: String,
  address: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Deserialize)]
struct InputDetail {
  output: String,
  address: Option<String>,
  value: u64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct TransactionJson {
  pub blockhash: Option<String>,
  pub chain: String,
  pub inscription: Option<String>,
  pub transaction: Transaction,
  pub txid: String,
  outputs: Vec<OutputJson>,
  inputs: Vec<InputDetail>,
}

use std::fmt;

impl fmt::Debug for OutputJson {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
      f,
      "OutputJson {{ value: {}, script_pubkey: {}, address: {:?} }}",
      self.value, self.script_pubkey, self.address
    )
  }
}

impl TransactionJson {
  pub fn new(
    index: Arc<Index>,
    blockhash: Option<BlockHash>,
    chain: Chain,
    inscription: Option<InscriptionId>,
    transaction: Transaction, // Assuming Transaction has a field `output`
    txid: Txid,
  ) -> Result<Self, anyhow::Error> {
    let outputs = transaction
      .output
      .iter()
      .enumerate()
      .map(|(vout, output)| {
        let _outpoint = OutPoint::new(txid, vout as u32); // Assuming OutPoint::new exists
        let address = match chain.address_from_script(&output.script_pubkey) {
          Ok(address) => Some(address.to_string()), // Assuming this is how you get the address
          Err(_) => None,
        };
        OutputJson {
          value: output.value, // Adjust according to your actual Output struct
          script_pubkey: output.script_pubkey.to_asm_string(), // Same here
          address,
        }
      })
      .collect();

    // Process inputs
    let inputs_result: Result<Vec<Option<InputDetail>>, anyhow::Error> = transaction
    .input
    .iter()
    .map(|input| {
        let outpoint = input.previous_output;

       let output_result: Result<Option<bitcoin::TxOut>, anyhow::Error> = index.get_transaction(outpoint.txid)
    .map_err(anyhow::Error::from) // Convert inner Result error to anyhow::Error
    .and_then(|opt_tx| match opt_tx {
        Some(tx) => tx.output.into_iter().nth(outpoint.vout as usize)
            .ok_or_else(|| anyhow::Error::msg(format!("Output not found for outpoint {}", outpoint)))
            .map(Some), // Wrap the TxOut in Some
        None => Ok(None), // Correctly return Result<Option<TxOut>, anyhow::Error>
    });


        output_result.map(|output_option| {
            output_option.map(|output| {
                let address = chain.address_from_script(&output.script_pubkey)
                    .ok()
                    .map(|addr| addr.to_string());

                let previous_value = output.value;

                InputDetail {
                    output: outpoint.to_string(),
                    address,
                    value: previous_value,
                }
            })
        })
    })
    .collect(); // Collects into Result<Vec<Option<InputDetail>>, anyhow::Error>

    // Handle the Result from inputs collection
    let inputs = inputs_result?
            .into_iter()
            .filter_map(|input_detail| input_detail) // Filter out None values
            .collect();

    Ok(Self {
      blockhash: blockhash.map(|bh| bh.to_string()),
      chain: chain.to_string(),
      inscription: inscription.map(|ins| ins.to_string()),
      transaction,
      outputs, // Add outputs to the struct
      inputs,
      txid: txid.to_string(),
    })
  }
}
impl PageContent for InscriptionHtml {
  fn title(&self) -> String {
    format!("Inscription {}", self.inscription_number)
  }

  fn preview_image_url(&self) -> Option<Trusted<String>> {
    Some(Trusted(format!("/content/{}", self.inscription_id)))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn without_sat_nav_links_or_output() {
    assert_regex_match!(
      InscriptionHtml {
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        <div class=inscription>
        <div>❮</div>
        <iframe .* src=/preview/1{64}i1></iframe>
        <div>❯</div>
        </div>
        <dl>
          <dt>id</dt>
          <dd class=monospace>1{64}i1</dd>
          <dt>preview</dt>
          <dd><a href=/preview/1{64}i1>link</a></dd>
          <dt>content</dt>
          <dd><a href=/content/1{64}i1>link</a></dd>
          <dt>content length</dt>
          <dd>10 bytes</dd>
          <dt>content type</dt>
          <dd>text/plain;charset=utf-8</dd>
          <dt>timestamp</dt>
          <dd><time>1970-01-01 00:00:00 UTC</time></dd>
          <dt>genesis height</dt>
          <dd><a href=/block/0>0</a></dd>
          <dt>genesis fee</dt>
          <dd>1</dd>
          <dt>genesis transaction</dt>
          <dd><a class=monospace href=/tx/1{64}>1{64}</a></dd>
          <dt>location</dt>
          <dd class=monospace>1{64}:1:0</dd>
          <dt>output</dt>
          <dd><a class=monospace href=/output/1{64}:1>1{64}:1</a></dd>
          <dt>offset</dt>
          <dd>0</dd>
          <dt>ethereum teleburn address</dt>
          <dd>0xa1DfBd1C519B9323FD7Fd8e498Ac16c2E502F059</dd>
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_output() {
    assert_regex_match!(
      InscriptionHtml {
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        output: Some(tx_out(1, address())),
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        <div class=inscription>
        <div>❮</div>
        <iframe .* src=/preview/1{64}i1></iframe>
        <div>❯</div>
        </div>
        <dl>
          .*
          <dt>address</dt>
          <dd class=monospace>bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4</dd>
          <dt>output value</dt>
          <dd>1</dd>
          .*
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_sat() {
    assert_regex_match!(
      InscriptionHtml {
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        output: Some(tx_out(1, address())),
        sat: Some(Sat(1)),
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        .*
        <dl>
          .*
          <dt>sat</dt>
          <dd><a href=/sat/1>1</a></dd>
          <dt>preview</dt>
          .*
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_prev_and_next() {
    assert_regex_match!(
      InscriptionHtml {
        children: Vec::new(),
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(2),
        next: Some(inscription_id(3)),
        inscription_number: 1,
        output: Some(tx_out(1, address())),
        previous: Some(inscription_id(1)),
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        <div class=inscription>
        <a class=prev href=/inscription/1{64}i1>❮</a>
        <iframe .* src=/preview/2{64}i2></iframe>
        <a class=next href=/inscription/3{64}i3>❯</a>
        </div>
        .*
      "
      .unindent()
    );
  }

  #[test]
  fn with_cursed_and_unbound() {
    assert_regex_match!(
      InscriptionHtml {
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(2),
        inscription_number: -1,
        output: Some(tx_out(1, address())),
        satpoint: SatPoint {
          outpoint: unbound_outpoint(),
          offset: 0
        },
        timestamp: timestamp(0),
        ..Default::default()
      },
      "
        <h1>Inscription -1</h1>
        .*
        <dl>
          .*
          <dt>location</dt>
          <dd class=monospace>0{64}:0:0</dd>
          <dt>output</dt>
          <dd><a class=monospace href=/output/0{64}:0>0{64}:0</a></dd>
          .*
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_parent() {
    assert_regex_match!(
      InscriptionHtml {
        parent: Some(inscription_id(2)),
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        <div class=inscription>
        <div>❮</div>
        <iframe .* src=/preview/1{64}i1></iframe>
        <div>❯</div>
        </div>
        <dl>
          <dt>id</dt>
          <dd class=monospace>1{64}i1</dd>
          <dt>parent</dt>
          <dd><a class=monospace href=/inscription/2{64}i2>2{64}i2</a></dd>
          <dt>preview</dt>
          <dd><a href=/preview/1{64}i1>link</a></dd>
          <dt>content</dt>
          <dd><a href=/content/1{64}i1>link</a></dd>
          <dt>content length</dt>
          <dd>10 bytes</dd>
          <dt>content type</dt>
          <dd>text/plain;charset=utf-8</dd>
          <dt>timestamp</dt>
          <dd><time>1970-01-01 00:00:00 UTC</time></dd>
          <dt>genesis height</dt>
          <dd><a href=/block/0>0</a></dd>
          <dt>genesis fee</dt>
          <dd>1</dd>
          <dt>genesis transaction</dt>
          <dd><a class=monospace href=/tx/1{64}>1{64}</a></dd>
          <dt>location</dt>
          <dd class=monospace>1{64}:1:0</dd>
          <dt>output</dt>
          <dd><a class=monospace href=/output/1{64}:1>1{64}:1</a></dd>
          <dt>offset</dt>
          <dd>0</dd>
          <dt>ethereum teleburn address</dt>
          <dd>0xa1DfBd1C519B9323FD7Fd8e498Ac16c2E502F059</dd>
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_children() {
    assert_regex_match!(
      InscriptionHtml {
        children: vec![inscription_id(2), inscription_id(3)],
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        <div class=inscription>
        <div>❮</div>
        <iframe .* src=/preview/1{64}i1></iframe>
        <div>❯</div>
        </div>
        <dl>
          <dt>children</dt>
          <dd>
            <div class=thumbnails>
              <a href=/inscription/2{64}i2><iframe .* src=/preview/2{64}i2></iframe></a>
              <a href=/inscription/3{64}i3><iframe .* src=/preview/3{64}i3></iframe></a>
            </div>
            <div class=center>
              <a href=/children/1{64}i1>all</a>
            </div>
          </dd>
          <dt>id</dt>
          <dd class=monospace>1{64}i1</dd>
          <dt>preview</dt>
          <dd><a href=/preview/1{64}i1>link</a></dd>
          <dt>content</dt>
          <dd><a href=/content/1{64}i1>link</a></dd>
          <dt>content length</dt>
          <dd>10 bytes</dd>
          <dt>content type</dt>
          <dd>text/plain;charset=utf-8</dd>
          <dt>timestamp</dt>
          <dd><time>1970-01-01 00:00:00 UTC</time></dd>
          <dt>genesis height</dt>
          <dd><a href=/block/0>0</a></dd>
          <dt>genesis fee</dt>
          <dd>1</dd>
          <dt>genesis transaction</dt>
          <dd><a class=monospace href=/tx/1{64}>1{64}</a></dd>
          <dt>location</dt>
          <dd class=monospace>1{64}:1:0</dd>
          <dt>output</dt>
          <dd><a class=monospace href=/output/1{64}:1>1{64}:1</a></dd>
          <dt>offset</dt>
          <dd>0</dd>
          <dt>ethereum teleburn address</dt>
          <dd>0xa1DfBd1C519B9323FD7Fd8e498Ac16c2E502F059</dd>
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_paginated_children() {
    assert_regex_match!(
      InscriptionHtml {
        children: vec![inscription_id(2)],
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        <div class=inscription>
        <div>❮</div>
        <iframe .* src=/preview/1{64}i1></iframe>
        <div>❯</div>
        </div>
        <dl>
          <dt>children</dt>
          <dd>
            <div class=thumbnails>
              <a href=/inscription/2{64}i2><iframe .* src=/preview/2{64}i2></iframe></a>
            </div>
            <div class=center>
              <a href=/children/1{64}i1>all</a>
            </div>
          </dd>
          <dt>id</dt>
          <dd class=monospace>1{64}i1</dd>
          <dt>preview</dt>
          <dd><a href=/preview/1{64}i1>link</a></dd>
          <dt>content</dt>
          <dd><a href=/content/1{64}i1>link</a></dd>
          <dt>content length</dt>
          <dd>10 bytes</dd>
          <dt>content type</dt>
          <dd>text/plain;charset=utf-8</dd>
          <dt>timestamp</dt>
          <dd><time>1970-01-01 00:00:00 UTC</time></dd>
          <dt>genesis height</dt>
          <dd><a href=/block/0>0</a></dd>
          <dt>genesis fee</dt>
          <dd>1</dd>
          <dt>genesis transaction</dt>
          <dd><a class=monospace href=/tx/1{64}>1{64}</a></dd>
          <dt>location</dt>
          <dd class=monospace>1{64}:1:0</dd>
          <dt>output</dt>
          <dd><a class=monospace href=/output/1{64}:1>1{64}:1</a></dd>
          <dt>offset</dt>
          <dd>0</dd>
          <dt>ethereum teleburn address</dt>
          <dd>0xa1DfBd1C519B9323FD7Fd8e498Ac16c2E502F059</dd>
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_rune() {
    assert_regex_match!(
      InscriptionHtml {
        genesis_fee: 1,
        inscription: inscription("text/plain;charset=utf-8", "HELLOWORLD"),
        inscription_id: inscription_id(1),
        inscription_number: 1,
        satpoint: satpoint(1, 0),
        rune: Some(Rune(0)),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        .*
        <dl>
          .*
          <dt>rune</dt>
          <dd><a href=/rune/A>A</a></dd>
        </dl>
      "
      .unindent()
    );
  }

  #[test]
  fn with_content_encoding() {
    assert_regex_match!(
      InscriptionHtml {
        genesis_fee: 1,
        inscription: Inscription {
          content_encoding: Some("br".into()),
          ..inscription("text/plain;charset=utf-8", "HELLOWORLD")
        },
        inscription_id: inscription_id(1),
        inscription_number: 1,
        satpoint: satpoint(1, 0),
        ..Default::default()
      },
      "
        <h1>Inscription 1</h1>
        .*
        <dl>
          .*
          <dt>content encoding</dt>
          <dd>br</dd>
          .*
        </dl>
      "
      .unindent()
    );
  }
}
