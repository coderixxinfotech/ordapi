
// to run: node --max-old-space-size=8192 ./index.ts

// NOTE: there is a possibility that if json contains \u0000, it'll be saved into text_content not content (jsonb)
const LIMIT = 10;
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import * as bitcoin from 'bitcoinjs-lib';
import ecc from 'tiny-secp256k1';
import { execSync } from 'child_process';
import readline from 'readline';
import process from 'process';

import { initializeDB } from './reset_init';

// models

import { OrdIndexerVersion, OrdNetworkType, BlockHashes, Inscription, ReorgStat } from "./models"
import dbConnect from './lib/dbConnect';
// import Transaction from './models/transaction';

bitcoin.initEccLib(ecc);

console.log("VERSION V1");

// for self-signed cert of postgres
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

// const promise_limit = 50000;


const chain_folder: string = process.env.BITCOIN_CHAIN_FOLDER || "~/.bitcoin/";
const bitcoin_rpc_user: string = process.env.BITCOIN_RPC_USER || "mempool";
const bitcoin_rpc_password: string = process.env.BITCOIN_RPC_PASSWD || "mempool";
const bitcoin_rpc_url: string = process.env.BITCOIN_RPC_URL || "bitcoin-container:8332";


let ord_binary: string = process.env.ORD_BINARY || "./../target/release/ord";
let ord_folder: string = process.env.ORD_FOLDER || ".";
if (ord_folder.length == 0) {
  console.error("ord_folder not set in .env, please run python3 reset_init.py");
  process.exit(1);
}
if (ord_folder[ord_folder.length - 1] != '/') ord_folder += '/';


const ord_datadir: string = process.env.ORD_DATADIR || "./mainnet";
const cookie_file: string = process.env.COOKIE_FILE || "";

const network_type: string = process.env.NETWORK_TYPE || "mainnet";

let network: bitcoin.Network | null = null;
let network_folder: string = "";


switch (network_type) {
  case "mainnet":
    network = bitcoin.networks.bitcoin;
    network_folder = "mainnet/";
    break;
  case "testnet":
    network = bitcoin.networks.testnet;
    network_folder = "testnet3/";
    break;
  case "signet":
    network = bitcoin.networks.testnet; // signet is not supported by bitcoinjs-lib but wallet_addr calculation is the same as testnet
    network_folder = "signet/";
    break;
  case "regtest":
    network = bitcoin.networks.regtest;
    network_folder = "regtest/";
    break;
  default:
    console.error("Unknown network type: " + network_type);
    process.exit(1);
}

console.log({ network })

const first_inscription_heights: { [key: string]: number } = {
  'mainnet': 856450,
  'testnet': 2413343,
  'signet': 112402,
  'regtest': 0,
};

const first_inscription_height: number = first_inscription_heights[network_type];
const fast_index_below: number = first_inscription_height + 7000;

const RECOVERABLE_DB_VERSIONS: number[] = [];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DB_VERSION = 1;
const INDEXER_VERSION = 1;
const ORD_VERSION = "0.18.5";

// import mempoolJS from "cryptic-mempool";
import { handlePreSaveLogic } from './insertSkippedBlock';
import axios from 'axios';

export function delay(sec: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, sec * 1000));
}

function save_error_log(log: string): void {
  console.error(log);
  fs.appendFileSync("log_file_error.txt", log + "\n");
}

async function main_index() {

console.log(execSync("pwd", { stdio: 'inherit' }))
  await check_db()

  let first = true;
  // eslint-disable-next-line no-constant-condition
    if (first) first = false
    else await delay(2)

    let start_tm = +(new Date())

    if (!fs.existsSync(ord_folder + network_folder + "inscriptions.txt")) {
      console.error("inscriptions.txt not found, creating in: "+ord_folder + network_folder + "inscriptions.txt")
      fs.writeFileSync(ord_folder + network_folder + "inscriptions.txt", '')
    }
    if (!fs.existsSync(ord_folder + network_folder + "log_file_index.txt")) {
      console.error("log_file_index.txt not found, creating")
      fs.writeFileSync(ord_folder + network_folder + "log_file_index.txt", '')
    }
    const blockhashes_result = await BlockHashes.find({}).sort({block_height: -1});

    // console.log({blockhashes_result})

    // Extract the max_height, defaulting to -1 if no documents were found
    let ord_last_block_height = blockhashes_result.length > 0 ? blockhashes_result[0].block_height : -1;

   


    if (ord_last_block_height < first_inscription_height) { // first inscription
      ord_last_block_height = first_inscription_height
    }

    let ord_index_st_tm = +(new Date())
    let ord_end_block_height = ord_last_block_height + LIMIT
    if (ord_last_block_height < fast_index_below) { // a random point where blocks start to get more inscription
      ord_end_block_height = ord_last_block_height + LIMIT
    }

     console.log({ord_last_block_height, first_inscription_height})
    let cookie_arg = cookie_file ? ` --cookie-file=${cookie_file} ` : ""

    let current_directory = process.cwd()
    process.chdir(ord_folder);

    let ord_version_cmd = ord_binary + " --version"

    let rpc_argument = ""
    if (bitcoin_rpc_url != "") {
      rpc_argument = " --bitcoin-rpc-url " + bitcoin_rpc_url
    }

    if (bitcoin_rpc_user != "") {
      rpc_argument += " --bitcoin-rpc-username " + bitcoin_rpc_user + " --bitcoin-rpc-password " + bitcoin_rpc_password
    }

    let network_argument = ""
    if (network_type == 'signet') {
      network_argument = " --signet"
    } else if (network_type == 'regtest') {
      network_argument = " --regtest"
    } else if (network_type == 'testnet') {
      network_argument = " --testnet"
    }

    let ord_index_cmd = ord_binary + network_argument + " --bitcoin-data-dir \"" + chain_folder + "\" --index-sats --index-runes --data-dir \"" + ord_datadir + "\"" + cookie_arg + " --height-limit " + (ord_end_block_height) + " " + rpc_argument + " index run"

    // TODO: Undo comment to start ord indexer
    try {
      let version_string = execSync(ord_version_cmd).toString()
      console.log("ord version: " + version_string)
      if (!version_string.includes(ORD_VERSION)) {
        console.error("ord version mismatch, please recompile ord via 'cargo build --release'.")
        process.exit(1)
      }
      // await check_max_transfer_cnts()
      console.log({ ord_index_cmd })
      // if (false)
        execSync(ord_index_cmd, { stdio: 'inherit' })
    }
    catch (err) {
      console.error("ERROR ON ORD!!!")
      console.error(err)
      process.chdir(current_directory);

      return;
    }
    process.chdir(current_directory);
    let ord_index_tm = +(new Date()) - ord_index_st_tm

    const fileStream = fs.createReadStream(ord_folder + network_folder + "inscriptions.txt", { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    let lines = []
    for await (const line of rl) {
      lines.push(line)
    }


    const currentHeightResult = await BlockHashes.aggregate([
      { $group: { _id: null, max_height: { $max: "$block_height" } } }
    ]);

    let current_height = currentHeightResult.length > 0 ? currentHeightResult[0].max_height : -1;



    let lines_index = fs.readFileSync(ord_folder + network_folder + "log_file_index.txt", "utf8").split('\n')
    if (lines_index.length == 1) {
      console.log("Nothing new, waiting!!")

      // check latest mempool height and latest height in our db to find if we skipped some blocks
      // const {data: mempool_height} = await axios.get(`https://mempool.ordinalnovus.com/api/blocks/tip/height`);
      // if(mempool_height > current_height)
      // {
      //   console.log({current_height})
      //    console.log(`We are ${mempool_height-current_height}  Blocks Behind`);
      //    for(let i = current_height + 1; i<=mempool_height; i++){
      //     await InsertSkippedBlock(i);

      //    }
      //    await cleanup()

      // }
      return;
    }

        await checkReorg(lines_index, current_height);
    console.log("No reorg found: ", {current_height})



    // some sanity checks and checks for possible early exit of ord
    let last_start_idx = null
    let last_start_block = null
    let last_end_idx = null
    let block_start_idxes: any = {}
    let next_expected_start = true
    let lenlines = lines.length
    let ioffset = 0
    for (let i = 0; i < lenlines; i++) {
      let l = lines[i + ioffset]
      if (l.trim() == "") { continue }

      // console.log({l})

      let parts = l.split('~||~')
      if (parts[0] != "cmd") { continue }
      if (parts[2] == "block_start") {
        if (last_start_idx == null && i != 0) {
          console.error("Faulty block_start position: " + l)
          process.exit(1)
        }
        let block_height = parseInt(parts[1])
        if ((last_start_block != null) && (block_height <= last_start_block)) {
          // repeating block_start, remove early entries
          console.error("start with less or equal block_height in latter: " + l)
          lines.splice(block_start_idxes[block_height] + ioffset, i + ioffset)
          ioffset -= i - block_start_idxes[block_height]
          let temp_i = 0
          while ((block_height + temp_i) in block_start_idxes) {
            delete block_start_idxes[block_height + temp_i]
            temp_i += 1
          }
        }
        else if (!next_expected_start) {
          console.error("two start but bigger block_height in latter: " + l)
          process.exit(1)
        }
        else if (i != ioffset && i - 1 != last_end_idx) {
          console.error("block_start not right after block_end: " + l)
          process.exit(1)
        }
        last_start_idx = i
        last_start_block = block_height
        next_expected_start = false
        block_start_idxes[block_height] = i
      }
      else if (parts[2] == "block_end") {
        if (next_expected_start) {
          console.error("NOT expected block_end: " + l)
          process.exit(1)
        }
        let block_height = parseInt(parts[1])
        if (block_height != last_start_block) {
          console.error("block_end block_height != block_start block_height: " + l)
          process.exit(1)
        }
        last_end_idx = i
        next_expected_start = true
      }
      else {
        continue
      }
    }
    if (!next_expected_start) {
      console.error("logs didn't end with block_end - did ord crash?")
      let all_tm = +(new Date()) - start_tm
      ord_index_tm = Math.round(ord_index_tm)
      all_tm = Math.round(all_tm)


      console.log({ ord_index_tm, all_tm })
      throw Error("convert code to use Mongodb")
      // await db_pool.query(`INSERT into ord_indexer_work_stats
      //     (ord_index_tm, all_tm)
      //     values ($1, $2);`, 
      //     [ord_index_tm, all_tm])
      return;
    }


    let ord_sql_st_tm = +(new Date())

    // let sql_query_insert_ord_number_to_id = `INSERT into ord_number_to_id (inscription_number, inscription_id, cursed_for_brc20, parent_id, block_height) values ($1, $2, $3, $4, $5);`
    // let sql_query_insert_transfer = `INSERT into ord_transfers (id, inscription_id, block_height, old_satpoint, new_satpoint, new_pkScript, new_wallet, sent_as_fee, new_output_value) values ($1, $2, $3, $4, $5, $6, $7, $8, $9);`
    // let sql_query_insert_content = `INSERT into ord_content (inscription_id, content, content_type, metaprotocol, block_height) values ($1, $2, $3, $4, $5);`
    // let sql_query_insert_text_content = `INSERT into ord_content (inscription_id, text_content, content_type, metaprotocol, block_height) values ($1, $2, $3, $4, $5);`

    let ord_sql_query_count = 0
    let new_inscription_count = 0
    let transfer_count = 0

    let max_height = -1
    for (const l of lines_index) {
      if (l.trim() == '') { continue }
      let parts = l.split(';')

      if (parts[0] != "cmd") { continue }
      if (parts[2] != "new_block") { continue }
      if (parseInt(parts[1]) > max_height) max_height = parseInt(parts[1])
    }




    console.log("db_height: " + current_height + " -> " + max_height)
    // let main_min_block_height = current_height + 1
    // let main_max_block_height = max_height

    // Query to find the maximum id in the ord_transfers collection
    // const transfer_result = await OrdTransfers.aggregate([
    //   {
    //     $group: {
    //       _id: null,
    //       maxid: { $max: "$id" }
    //     }
    //   }
    // ]);

    // Extract the maxid, defaulting to -1 if no documents were found
    // let current_transfer_id = transfer_result.length > 0 ? transfer_result[0].maxid : -1;

    // Increment the current_transfer_id by 1
    // current_transfer_id = current_transfer_id + 1;

    let future_sent_as_fee_transfer_id: any = {}
    let inscription_ops:any = []
    let transfer_ins_ops: any = [];
    
    let idx = 0
    for (const l of lines) {
      if (l.trim() == '') { continue }
      idx += 1
      if (idx % 10000 == 0) console.log(idx + " / " + lines.length)

      let parts = l.split('~||~')
      if (parts[0] != "cmd") { continue }

      // if (inscription_ops.length > promise_limit) {
      //   await Promise.all(inscription_ops)
      //   inscription_ops = []
      // }

      let block_height = parseInt(parts[1].split(":")[1])
      if (block_height <= current_height) continue
      if (parts[2] == "block_start") continue
      else if (parts[2] == "block_end") continue
      else if (parts[2] == "insert") {
        if (parts[3] == "number_to_id") {
          // if (block_height > current_height) {
          //   let parent = parts[7]
          //   if (parent == "") parent = null
          //   console.log({insert_ins_number_to_id: {
          //     parts, parent, block_height, l
          //   }}, '--1')
          //   inscription_ops.push(execute_on_db(sql_query_insert_ord_number_to_id, [parseInt(parts[4]), parts[5], parts[6] == "1", parent, block_height]))
          new_inscription_count += 1
          //   ord_sql_query_count += 1
          // }
        }
        // else if (parts[3] == "early_transfer_sent_as_fee") {
          // if (block_height > current_height) {
            // future_sent_as_fee_transfer_id[parts[4]] = [current_transfer_id, false, block_height]
            // current_transfer_id += 1
          // }
        // }
        else if (parts[3] == "transfer") {
          const inscription_id = parts[4].split(":")[1];
          if (block_height > current_height) {
            if ((inscription_id in future_sent_as_fee_transfer_id) && (future_sent_as_fee_transfer_id[inscription_id][2] == block_height)) {
              let pair = future_sent_as_fee_transfer_id[parts[4]]
              let transfer_id = pair[0]
              if (pair[1]) {
                save_error_log("--------------------------------")
                save_error_log("ERROR: early transfer sent as fee already used")
                save_error_log("On inscription: " + parts[4])
                save_error_log("Transfer: " + l)
                delay(10)
                process.exit(1)
              }
              future_sent_as_fee_transfer_id[parts[4]][1] = true;
              console.log({
                insert_transfer: {
                  parts, l
                }
              }, '--2')
              throw Error("handle this transfer: " + transfer_id)
              // inscription_ops.push(execute_on_db(sql_query_insert_transfer, [transfer_id, parts[4], block_height, parts[5], parts[6], parts[8], wallet_from_pkscript(parts[8], network), parts[7] == "true" ? true : false, parseInt(parts[9])]))
              transfer_count += 1
              ord_sql_query_count += 1
            } else {
              //   console.log({insert_transfer: {
              //     parts, sql_query_insert_transfer, l
              // }}, '--3');

              if (parts[7].split(":")[1].trim() === "true") {
                continue;
                throw new Error("Spent as fee");
              }


              const doc = {
                location: parts[6].split(":")[1] + ":" + parts[6].split(":")[2] + ":" + parts[6].split(":")[3],
                output: parts[6].split(":")[1] + ":" + parts[6].split(":")[2],
                output_value: parseInt(parts[9].split(":")[1]),
                address: parts[10].split(":")[1].split(`"`)[1],
                txid: parts[6].split(":")[1],
                listed: false,
                in_mempool: false,
                signed_psbt: "",
                unsigned_psbt: "",
                tap_internal_key : ""
              }

              const transfer_doc = {                
                block_height: parseInt(parts[1].split(":")[1]),
                old_output: parts[5].split(":")[1] + ":" + parts[5].split(":")[2],
                new_location: parts[6].split(":")[1] + ":" + parts[6].split(":")[2] + ":" + parts[6].split(":")[3],
                new_output: parts[6].split(":")[1] + ":" + parts[6].split(":")[2],
                new_output_value: parseInt(parts[9].split(":")[1]),
                to: parts[10].split(":")[1].split(`"`)[1],
                timestamp: parseInt(parts[11].split(":")[1]) * 1000, 
                txid: parts[6].split(":")[1]
              };

              transfer_ins_ops.push({
                updateOne: {
                  filter: { output: transfer_doc.old_output },
                  update: { $set: doc },
                  // upsert: true
                }
              },)
              // inscription_ops.push(execute_on_db(sql_query_insert_transfer, [current_transfer_id, parts[4], block_height, parts[5], parts[6], parts[8], wallet_from_pkscript(parts[8], network), parts[7] == "true" ? true : false, parseInt(parts[9])]))
              // current_transfer_id += 1
              transfer_count += 1
              ord_sql_query_count += 1
            }
          }
        }
        else if (parts[3] == "content") {

          if (block_height > current_height) {
            // get string after 7th semicolon
            let content = parts.slice(8).join(';')
            if (parts[5] == 'true') { // JSON
              if (!content.includes('\\u0000')) {
                // console.log({
                //   insert_content: {
                //     parts, l
                //   }
                // }, '--4');
              

                const doc = processDoc(parts)
                if(doc){
                  inscription_ops.push({
                updateOne: {
                  filter: { inscription_id: doc.inscription_id },
                  update: {$set: filterEmptyFields(doc)}
                }
              });

                // if(doc.content_type?.includes("image"))
                // console.log("--4", { doc, parts })
                // inscription_ops.push(execute_on_db(sql_query_insert_content, [parts[4], content, parts[6], parts[7], block_height]))
                ord_sql_query_count += 1
                }
              } else {
                console.log({
                  insert_text_content: {
                    parts, l
                  }
                }, '--5')
                throw Error("--5 => handle MONGODB ")
                // inscription_ops.push(execute_on_db(sql_query_insert_text_content, [parts[4], content, parts[6], parts[7], block_height]))
                ord_sql_query_count += 1
                save_error_log("--------------------------------")
                save_error_log("Error parsing JSON: " + content)
                save_error_log("On inscription: " + parts[4])
              }
            } else {
              //    console.log({insert_text_content: {
              //     parts, sql_query_insert_text_content, l
              // }}, '--6');
             const doc = processDoc(parts)
             if(doc){

              inscription_ops.push({
                updateOne: {
                  filter: { inscription_id: doc.inscription_id },
                  update: {$set: filterEmptyFields(doc)}
                }
              });

              // inscription_ops.push(execute_on_db(sql_query_insert_text_content, [parts[4], content, parts[6], parts[7], block_height]))
              ord_sql_query_count += 1
             }
            }
          }
        }
      }
    }


    console.log("All OPS built. new ins length: ", inscription_ops.length, " \nTransfer Docs: ", transfer_ins_ops.length);
    console.log("Updating...")
    // console.log("New ins: ", inscription_ops.length - transfer_ops.length)

    const insertOps: any[] = inscription_ops.sort((a:any,b:any)=>a.updateOne.update.$set.inscription_number-b.updateOne.update.$set.inscription_number);
    console.log("writing transfer ops...");

    // Assuming transfer_ins_ops is an array of operations
    // Use a Map to filter out duplicates based on a unique field (e.g., _id)
    const uniqueOps = new Map();

    transfer_ins_ops.forEach((op: any) => {
    const key = op.updateOne.filter.output; // Adjust based on your unique identifier
    uniqueOps.set(key, op); // Overwrites any previous entry for this key
    });


    // Convert the Map back to an array
    const uniqueTransferOps = Array.from(uniqueOps.values());
    console.log(`writing ${uniqueTransferOps.length} unique transfer ops...`)

    await dbConnect()
    await Inscription.bulkWrite(uniqueTransferOps);


    console.log("handling cleanup..")

    const transformedBulkOps = await handlePreSaveLogic(insertOps)
  console.log("cleanup done.")


  if (transformedBulkOps.length) {
    const bulkWriteOperations = transformedBulkOps.map((transformedDoc) => {
      return {
        updateOne: {
          filter: { inscription_id: transformedDoc.inscription_id }, // or whatever your unique identifier is
          update: { $set: transformedDoc },
          upsert: true,
        },
      };
    });
    console.log("writing...")
    await Inscription.bulkWrite(bulkWriteOperations);
  }

  console.log(`updated ${transformedBulkOps.length} docs`);

await cleanup()

    // await OrdTransfers.bulkWrite(transfer_ops);


    inscription_ops = []

    for (const l of lines_index) {
      if (l.trim() == '') { continue }
      let parts = l.split(';')

      if (parts[0] != "cmd") { continue }
      if (parts[2] != "new_block") { continue }

      let block_height = parseInt(parts[1])
      if (block_height < first_inscription_height) { continue }
      let blockhash = parts[3].trim()

      await BlockHashes.updateOne(
        { block_height }, // Filter: document with the specified block_height
        { $setOnInsert: { block_height, blockhash } }, // Insert only if it doesn't exist
        { upsert: true } // Insert a new document if no matching document is found
      );
      console.log(`Block height ${block_height} with hash ${blockhash} has been inserted or already exists.`);

    }

    let ord_sql_tm = +(new Date()) - ord_sql_st_tm

    console.log("Updating Log Files")
    let update_log_st_tm = +(new Date())
    fs.writeFileSync(ord_folder + network_folder + "inscriptions.txt", '')
    fs.writeFileSync(ord_folder + network_folder + "log_file_index.txt", '')
    let update_log_tm = +(new Date()) - update_log_st_tm

    ord_index_tm = Math.round(ord_index_tm)
    ord_sql_tm = Math.round(ord_sql_tm)
    update_log_tm = Math.round(update_log_tm)

    let all_tm = +(new Date()) - start_tm
    all_tm = Math.round(all_tm)

    // throw Error("Handle mongodb")

    // await db_pool.query(`INSERT into ord_indexer_work_stats
    //   (main_min_block_height, main_max_block_height, ord_sql_query_count, new_inscription_count, 
    //     transfer_count, ord_index_tm, ord_sql_tm, update_log_tm, all_tm)
    //   values ($1, $2, $3, $4, $5, $6, $7, $8, $9);`, 
    //     [main_min_block_height, main_max_block_height, ord_sql_query_count, new_inscription_count, 
    //       transfer_count, ord_index_tm, ord_sql_tm, update_log_tm, all_tm])

    console.log("ALL DONE")
  
}


// const init = async () => {
//   try {
//     const {
//       bitcoin: { websocket },
//     } = mempoolJS({
//       hostname: "mempool.ordinalnovus.com",
//     });
//     await check_db();


//     const blockQueue: any[] = [];

//         let lines_index = fs.readFileSync(ord_folder + network_folder + "log_file_index.txt", "utf8").split('\n')
//     if (lines_index.length >=1) {
//       const start_height_in_file = Number(lines_index[0].split(";")[1]);

//       const db_current_height = await BlockHashes.findOne({}).sort({block_height: -1});

//       const db_current_inscription_height = await Inscription.findOne({}).sort({inscription_number: -1});

//       const lower_height = db_current_inscription_height && db_current_height && db_current_inscription_height.genesis_height < db_current_height?.block_height? db_current_inscription_height.genesis_height: db_current_height?.block_height;
      
//       if (db_current_height && start_height_in_file - db_current_height?.block_height > 1) {
//         console.log({ db_current_height: db_current_height.block_height, start_height_in_file, diff: start_height_in_file - db_current_height?.block_height - 1 });
//         console.log(`We skipped ${start_height_in_file - db_current_height?.block_height - 1} Blocks`);

//         for (let i = lower_height + 1; i < start_height_in_file; i++) {
//           console.log({ adding_block: i });

//           let retryCount = 0;
//           const maxRetries = 5;
//           let success = false;

//           while (retryCount < maxRetries && !success) {
//             try {
//               await InsertSkippedBlock(i); // Try to insert the block
//               success = true; // If successful, break out of the retry loop
//               console.log(`Block ${i} inserted successfully`);
//             } catch (error) {
//               retryCount++;
//               console.log(`Failed to insert block ${i}. Attempt ${retryCount} of ${maxRetries}`);

//               if (retryCount < maxRetries) {
//                 await delay(2); // Wait for 2 seconds before retrying
//               } else {
//                 console.log(`Max retries reached for block ${i}. Moving on...`);
//               }
//             }
//           }
//         }
//       }
//     }

//    await main_index();

//     const processQueue = async () => {
//       while (blockQueue.length > 0) {
//         // const blockData = blockQueue.shift();
//         console.log(`need to process ${blockQueue.length-1} more times. ID: ${blockQueue.length}`)
//         console.log(`${blockQueue.length} items in Queue`)
//         await main_index();
//       }
//     };

//     // Function to establish WebSocket connection
//     const connectWebSocket = () => {
//       const ws = websocket.wsInit();

     
//       // Event listener for incoming WebSocket messages
// ws.addEventListener("message", async function incoming({ data }: any) {
//   // Parse the incoming data as JSON
//   data = JSON.parse(data.toString());

//   // Check if the data contains a block
//   if (data.block) {
//     // Connect to the database
//     await dbConnect();

//     // Get the current block height from the database
//     const currentHeightResult = await BlockHashes.aggregate([
//       { $group: { _id: null, max_height: { $max: "$block_height" } } }
//     ]);

//     // Set the current block height, or -1 if no blocks are found
//     let current_height = currentHeightResult.length > 0 ? currentHeightResult[0].max_height : -1;

//     // Fetch the current block height from the mempool API
//     const { data: mempool_height } = await axios.get(`https://mempool.ordinalnovus.com/api/blocks/tip/height`);

//     // If the mempool height is greater than the current height, process the difference
//     if (mempool_height > current_height) {
//       console.log({ diff: mempool_height - current_height, queue: blockQueue.length });

//       // Calculate the number of blocks that need to be processed
//       const diff = mempool_height - current_height;

//       const requiredItems = Math.ceil(diff / LIMIT);

//         // Push new items into the blockQueue if there are not enough
//         while (blockQueue.length < requiredItems) {
//           blockQueue.push(data);
//         }


//       // Log the number of blocks that are behind
//       console.log(`We are ${diff} Blocks Behind and number of times it will be processed: ${blockQueue.length}`);
//     }

//     // If this is the first block in the queue, start processing
//     if (blockQueue.length === 1) {
//       console.log("starting process execution...")
//       processQueue();
//     }
//   }
// });


//       const reconnectWebSocket = (attempt = 1) => {
//         const delay = Math.min(60000, attempt * 5000 + Math.random() * 5000);
//         setTimeout(init, delay);
//       };

//       ws.addEventListener("close", () => {
//         console.log("WebSocket was closed. Attempting to reconnect...");
//         reconnectWebSocket();
//       });

//       ws.addEventListener("error", (error: any) => {
//         console.error("WebSocket error:", error);
//         ws.close();
//         reconnectWebSocket();
//       });

//       websocket.wsWantData(ws, [
//         "blocks",
//         "stats",
//         "mempool-blocks",
//         "live-2h-chart",
//       ]);
//     };

//     // Initial call to connect the WebSocket
//     connectWebSocket();
//   } catch (error) {
//     console.log("Initialization error:", error);
//   }
// };



async function fix_db_from_version(db_version: string | number) {
  console.error("Unknown db_version: " + db_version)
  process.exit(1)
}


const checkReorg = async (lines_index: string[], current_height: number) => {
  // TODO: FIX THIS SHIT
  // The function checks for potential blockchain reorganization (reorg)
  // by comparing block heights and block hashes in the provided `lines_index` array 
  // with those stored in the database.

  console.log("Checking for possible reorg"); // Log that the reorg check has started

  // Iterate over each line in the `lines_index` array
  for (const l of lines_index) {
    if (l.trim() === "") continue; // Skip empty lines

    const parts = l.split(';'); // Split the line into parts using ';' as the delimiter
    if (parts[2].trim() === "new_block") { // Check if the third part indicates a new block
      const block_height = parseInt(parts[1].trim(), 10); // Extract and parse the block height
      
      // Skip the block if its height is greater than the current height (height in DB) or less than the first inscription height
      if (block_height > current_height) continue;
      if (block_height < first_inscription_height) continue;

      console.warn("Block repeating, possible reorg!!"); // Warn that a block is repeating, indicating a possible reorg
      const blockhash = parts[3].trim(); // Extract the block hash from the line

      // Fetch the block hash from the database for the given block height
      const blockHashDb = await BlockHashes.findOne({ block_height });

      // If a block hash exists in the database and it does not match the one in the line, a reorg is detected
      if (blockHashDb && blockHashDb.blockhash !== blockhash) {
        const reorg_st_tm = Date.now(); // Record the start time of reorg handling
        console.error(`Reorg detected at block_height ${block_height}`); // Log that a reorg has been detected

        // The following code is commented out but would revert to the previous block height
        // and log the reorg handling time.
        await handle_reorg(block_height);
        console.log(`Reverted to block_height ${block_height - 1}`);

        const reorg_tm = Math.round(Date.now() - reorg_st_tm); // Calculate the reorg handling time
        // The following code is commented out but would insert the reorg stats into the database.
        await ReorgStat.create({
          reorg_tm,
          old_block_height: current_height,
          new_block_height: block_height - 1,
        });

        // Update the current height to the lesser of the current height or the previous block height
        current_height = Math.min(current_height, block_height - 1);
      }
    }
  }
};


async function check_db(): Promise<void> {
  console.log("checking db");

  try {
    await dbConnect()
    // Fetching the db_version from the ord_indexer_version collection
    const dbVersionDoc = await OrdIndexerVersion.findOne({});
    if (!dbVersionDoc) throw new Error("db_version not found");

    const db_version = dbVersionDoc.db_version;
    if (db_version !== DB_VERSION) {
      if (RECOVERABLE_DB_VERSIONS.includes(db_version)) {
        console.error("db_version mismatch, will be automatically fixed");
        await fix_db_from_version(db_version);
        await OrdIndexerVersion.updateOne({}, { db_version: DB_VERSION, indexer_version: INDEXER_VERSION, ord_version: ORD_VERSION });
      } else {
        console.error("db_version mismatch, db needs to be recreated from scratch, please run reset_init.py");
        process.exit(1);
      }
    }
  } catch (err) {
    await initializeDB()
    console.error(err);
    console.error("db_version not found, db needs to be recreated from scratch, please run reset_init.py");
    process.exit(1);
  }

  // Fetching a document from ord_network_type collection
  const networkTypeDoc = await OrdNetworkType.findOne({});
  if (!networkTypeDoc) {
    console.error("ord_network_type not found, db needs to be recreated from scratch, please run reset_init.py");
    process.exit(1);
  }

  const network_type_db = networkTypeDoc.network_type;
  if (network_type_db !== network_type) {
    console.error("network_type mismatch, db needs to be recreated from scratch, please run reset_init.py");
    process.exit(1);
  }

  // Fetching the max block_height from block_hashes collection
  const currentHeightDoc = await BlockHashes.aggregate([
    { $group: { _id: null, max_height: { $max: "$block_height" } } }
  ]);

  const current_height = currentHeightDoc.length > 0 ? currentHeightDoc[0].max_height : -1;
  console.log("current_height: " + current_height);

  // Fetching the max block_height from ord_transfers collection
  // const currentTransferHeightDoc = await OrdTransfers.aggregate([
  //   { $group: { _id: null, max_height: { $max: "$block_height" } } }
  // ]);

  // const current_transfer_height = currentTransferHeightDoc.length > 0 ? currentTransferHeightDoc[0].max_height : -1;
  // console.log("current_transfer_height: " + current_transfer_height);

  // Fetching the max block_height from ord_number_to_id collection
  // const currentOrdNumberToIdHeightDoc = await OrdNumberToId.aggregate([
  //   { $group: { _id: null, max_height: { $max: "$block_height" } } }
  // ]);

  // const current_ord_number_to_id_height = currentOrdNumberToIdHeightDoc.length > 0 ? currentOrdNumberToIdHeightDoc[0].max_height : -1;
  // console.log("current_ord_number_to_id_height: " + current_ord_number_to_id_height);

  // Fetching the max block_height from ord_content collection
  // const currentContentHeightDoc = await Inscription.aggregate([
  //   { $group: { _id: null, max_height: { $max: "$genesis_height" } } }push
  // ]);

  // const current_content_height = currentContentHeightDoc.length > 0 ? currentContentHeightDoc[0].max_height : -1;
  // console.log("current_inscription_height: " + current_content_height);

  // Handling discrepancies in heights
  // if (current_height < current_transfer_height) {
  //   console.error("current_height < current_transfer_height");
  //   await OrdTransfers.deleteMany({ block_height: { $gt: current_height } });
  // }
  // if (current_height < current_ord_number_to_id_height) {
  //   console.error("current_height < current_ord_number_to_id_height");
  //   await OrdNumberToId.deleteMany({ block_height: { $gt: current_height } });
  // }
  // if (current_height < current_content_height) {
  //   console.error("current_height < current_content_height");
  //   console.log("These docs need to be deleted. ", {current_height})
  //   // await Inscription.deleteMany({ block_height: { $gt: current_height } });
  // }
  const latest_inscription_block = await Inscription.findOne({}).sort({inscription_number: -1});
  const latest_block_height = await BlockHashes.findOne({}).sort({block_height: -1});


  if( latest_block_height && latest_inscription_block && latest_block_height?.block_height>latest_inscription_block.genesis_height){
    // Extra Blockhash found with no related inscription in DB
    // Its possible the block has zero inscriptions

      const url = `${process.env.PROVIDER}/block/${latest_block_height?.block_height}`;

  console.log({ url });

  // const result = await axios.get(url, {
  //   headers: { Accept: "application/json" },
  // });

  // const data = result.data;
  // console.log({data})

// if(data.inscriptions.length){
//    await BlockHashes.deleteMany({block_height: {$gt: latest_inscription_block.genesis_height}});
//     console.log(`Latest Ins and Latest Blockhash height was mismatched so deleted wrong Blockhashes`);
//     throw Error(
//       'HEIGHT MISMATCH BETWEEN INSCRIPTION AND BLOCKHASHES'
//     )
// }
   
  }

  console.log("checked")
}



// main_index()
// 
async function forever_loop(){
  while(true){
    await main_index();
    await delay(30)
  
  }
}

forever_loop()

enum Charm {
  Coin = 0,
  Cursed = 1,
  Epic = 2,
  Legendary = 3,
  Lost = 4,
  Nineball = 5,
  Rare = 6,
  Reinscription = 7,
  Unbound = 8,
  Uncommon = 9,
  Vindicated = 10,
  Mythic = 11,
}

const ALL_CHARMS: Charm[] = [
  Charm.Coin,
  Charm.Uncommon,
  Charm.Rare,
  Charm.Epic,
  Charm.Legendary,
  Charm.Mythic,
  Charm.Nineball,
  Charm.Reinscription,
  Charm.Cursed,
  Charm.Unbound,
  Charm.Lost,
  Charm.Vindicated,
];

function flag(charm: Charm): number {
  return 1 << charm;
}

function isCharmSet(charms: number, charm: Charm): boolean {
  return (charms & flag(charm)) !== 0;
}

function charmsSet(charms: number): Charm[] {
  return ALL_CHARMS.filter(charm => isCharmSet(charms, charm));
}

function displayCharm(charm: Charm): string {
  switch (charm) {
    case Charm.Coin: return "coin";
    case Charm.Cursed: return "cursed";
    case Charm.Epic: return "epic";
    case Charm.Legendary: return "legendary";
    case Charm.Lost: return "lost";
    case Charm.Mythic: return "mythic";
    case Charm.Nineball: return "nineball";
    case Charm.Rare: return "rare";
    case Charm.Reinscription: return "reinscription";
    case Charm.Unbound: return "unbound";
    case Charm.Uncommon: return "uncommon";
    case Charm.Vindicated: return "vindicated";
    default: return "";
  }
}


function parseMetadata(metadata: string): Record<string, any> {
    // Remove the outer `"` and any escaping `\`
    metadata = metadata.replace(/^"|"$/g, '').replace(/\\"/g, '"');

    // Extract the key-value pair from the string
    const keyValuePattern = /Text\("([^"]+)"\),\s*Integer\(Integer\((\d+)\)\)/;
    const match = metadata.match(keyValuePattern);

    if (match) {
        const key = match[1]; // The key "ID"
        const value = parseInt(match[2], 10); // The value 89 as a number

        // Create the resulting object
        const result: Record<string, any> = {};
        result[key] = value;
        return result;
    }

    // Return an empty object if the pattern does not match
    return {};
}

const filterEmptyFields = (doc:any) => {
  return Object.fromEntries(
    Object.entries(doc).filter(([_, value]) => {
      return (
        value !== null &&
        value !== undefined &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
      );
    })
  );
};

const processDoc=(parts:string[])=>{

    const location_regex = /txid:\s*0x([a-fA-F0-9]+),\s*vout:\s*(\d+)\s*},\s*offset:\s*(\d+)/;

    const sat_regex = /sat:(?:Some\()?Sat\((\d+)\)\)?/;


          let charms = null;
          charms = parseInt(parts[14].split(":")[1], 10);
          charms = charmsSet(charms).map(displayCharm)

          const sat_match = parts[11].match(sat_regex);
          let satValue = "";
          if (sat_match) {
            satValue = BigInt(sat_match[1]).toString(); // Use BigInt if the number is very large
            // console.log('sat:', satValue);
          } else {
            // console.error('No match found');
            throw Error("no sat found")
          }


          const match = parts[13].match(location_regex);
          let location = "";
          let output = "";

          if (match) {
            const txid = match[1];
            const vout = parseInt(match[2], 10);
            const offset = parseInt(match[3], 10);
            output = txid + ":" + vout;
            location = txid + ":" + vout + ":" + offset;
          } else {
            throw Error("cant determine location")
            console.error('No match found');
          }

          let metadata : any= parts[20].substring(10, parts[20].length-1);
          if(metadata!=='')
          {
            metadata = parseMetadata(metadata);}
            else{
              metadata = null;
            }

          // let rune = parts[19].substring(5)||null;
          // if(rune!=="None")
          //   throw Error("Rune present: "+rune)
          // else rune = null

          const sha = parts[18].substring(5, parts[18].length-1)||null;
         
const delegate_regex = /txid:\s*0x([0-9a-fA-F]{64}),\s*index:\s*(\d+)/;

// Apply the regex pattern to the input string
const delegate_matches = parts[17].match(delegate_regex);

// console.log({ parts });
let delegate = null;
if (delegate_matches) {
    const txid = delegate_matches[1];  // Capture the txid without the 0x prefix
    const index = delegate_matches[2]; // Capture the index
    
    // console.log("txid:", txid);
    // console.log("index:", index);
    delegate = txid + "i" + index;  // Combine txid and index with "i"
    
    
    // console.log("delegate:", delegate);
} else {
    // console.log("No match found.");
}



   const inscription_details = {
                genesis_height: parseInt(parts[1].split(":")[1]),
                inscription_number: parseInt(parts[4].split(":")[1]),
                inscription_id: parts[5].split(":")[1],
                content_type: parts[7].split(":")[1] || null,
                metaprotocol: parts[8].substring("metaprotocol:".length) || null,
                parsed_metaprotocol: [],
                content: !delegate? parts[9].includes("content_json:") ? parts[9].substring("content_json:".length) : parts[9].substring("content:".length) || null:null,
                parents: parts[10].split(":")[1] || null,
                sat: satValue,
                timestamp: parseInt(parts[12].split(":")[1]) * 1000,
                location,
                output,
                charms_array: charms,
                output_value: parseInt(parts[15].split(":")[1]),
                address: parts[16].split(":")[1].split(`"`)[1],
                is_json: parts[6].split(":")[1] === "true",
                metadata,
                sha: sha && !delegate? sha: null, 
                delegate
              }

              // if(inscription_details.metaprotocol){

              
              //   console.log({inscription_details})
              //   throw Error("e")
              
              // }

              // if(inscription_details.inscription_id==="c8cc34fbe3d41aed6c48831a80a1cf4d1b0ee981ca507d902fc71fb2a81efc44i0")
              //  {
              //   console.log({inscription_details})
              //   throw Error("e")
              //  }

                let content = inscription_details.content||null;
 
    let token = false;
    let contentType = null;
    let tags: string[] = [];
    let isJson = inscription_details.is_json||false;

    // if(isJson && content){
    //   content = JSON.parse(content);
    // }

      contentType = inscription_details.content_type || null;

      // console.log({contentResponse})

      if (contentType) {
        if (/text|html|json|javascript/.test(contentType)) {


        try {

          if (content?.toLowerCase() && content.startsWith("cbrc-20:")) {
            tags.push("cbrc");
            tags.push("token");
            token = true;
          }
         if(content && isJson){
           const parsedContent = JSON.parse(content.toString());

          if (parsedContent.p === "brc-20") {
            tags.push("brc-20");
            tags.push("token");
            token = true;
          } else if (
            parsedContent.p === "sns" ||
            parsedContent.p.includes("sns")
          ) {
            tags.push("token");
            token = true;
          } else if (
            parsedContent.p === "brc-21" ||
            parsedContent.p.includes("orc")
          ) {
            tags.push("token");
            token = true;
          } else if (
            parsedContent.p &&
            parsedContent.tick &&
            parsedContent.amt
          ) {
            token = true;
            tags.push("token");
          } else if (
            parsedContent.p &&
            parsedContent.op &&
            (parsedContent.dep || parsedContent.tick || parsedContent.amt)
          ) {
            token = true;
            tags.push("token");
            tags.push("dmt");
          }
         }
        } catch (error) {}
    
          // handle multiple tap mints like inscription 46225391
          if (
            isJson && content &&
            content.includes(`"p":`) &&
            content.includes(`"op":`) &&
            (content.includes(`"tick":`) || content.includes(`"amt":`))
          ) {
            if (!tags.includes("token")) tags.push("token");
            token = true;
          }

        } 
      }

        if (inscription_details.metadata)
    inscription_details.metadata = new Map(
      Object.entries(inscription_details.metadata)
    );


  if (
    inscription_details.metaprotocol &&
    inscription_details.metaprotocol?.startsWith("cbrc-20")
  ) {
    token = true;
    tags.push("token");
    tags.push("cbrc");
  }
  if (inscription_details.metaprotocol)
    //@ts-ignore
    inscription_details.parsed_metaprotocol = inscription_details?.metaprotocol;

    // inscription_details.sha = null;
    inscription_details.content = null;


      const truncatedContent =
        content && content.length > 15000 ? content.substring(0, 15000) : content;
      const newItem = {
       ...inscription_details,
        tags:tags.filter((tag) => tag).map((tag) => tag.toLowerCase()),
        token,
         // Conditionally update content if it's not a token
        ...(!token &&
          content &&
          sha &&
          contentType && 
          !/image|audio|zip|video/.test(contentType) && {
            content: truncatedContent,
          }),

        // Conditionally update sha if it's not a token and certain conditions are met
        ...(!token &&
          sha &&
          (!inscription_details.metaprotocol || !inscription_details.metaprotocol.includes("transfer")) && {
            sha,
          }),
      };
    

      if(newItem.token && !newItem.tags.includes("cbrc")){
        return null;
      }
    
  return newItem
}

const handle_reorg = async (block_height: number): Promise<void> => {
  try {
    console.log(`Starting reorg process for block height ${block_height}...`);

    // Delete inscriptions with genesis_height greater than the specified block_height
    const inscriptionResult = await Inscription.deleteMany({ genesis_height: { $gt: block_height } });
    console.log(`Deleted ${inscriptionResult.deletedCount} inscriptions with genesis_height > ${block_height}`);

    // Delete block hashes with block_height greater than the specified block_height
    const blockHashesResult = await BlockHashes.deleteMany({ block_height: { $gt: block_height } });
    console.log(`Deleted ${blockHashesResult.deletedCount} block hashes with block_height > ${block_height}`);

    console.log(`Reorg process completed successfully for block height ${block_height}.`);

  } catch (error:any) {
    console.error(`Error during reorg process for block height ${block_height}: ${error.message}`);
    throw new Error("Reorg handling failed");
  }
};


export async function cleanup(block?: number) {
  await dbConnect();
  console.log("starting cleanup");

  // Start time
  console.time("cleanupOperation");

  const fieldsToCheck = [
    "children",
    "lists",
    "tags",
    "charms_array",
    "parsed_metaprotocol",
    "attributes",
    "delegate",
    "metaprotocol",
    "metadata",
    "sha",
    "location",
    "output",
    "address",
    "content",
    "content_type",
  ];

  const query = {
    $or: [
      { lists: [] },
      { children: [] },
      { tags: { $in: [null, []] } }, // Only check for null or empty array
      { charms_array: { $in: [null, []] } },
      { parsed_metaprotocol: { $in: [null, []] } },
      { attributes: { $in: [null, []] } },
      { delegate: { $in: [null, ""] } }, // Check for null or empty string
      { metaprotocol: { $in: [null, ""] } },
      { metadata: { $in: [null, ""] } },
      { sha: { $in: [null, ""] } },
      { content_type: { $in: [null, ""] } },
      { location: { $in: [null, ""] } },
      { output: { $in: [null, ""] } },
      { address: { $in: [null, ""] } },
      { content: { $in: [null, ""] } },
    ],
  };

  // Construct the $set pipeline stage to remove falsy values
  const setQuery = fieldsToCheck.reduce((set, field) => {
    //@ts-ignore
    set[field] = {
      $cond: {
        if: { $in: [`$${field}`, [null, [], ""]] },
        then: "$$REMOVE",
        else: `$${field}`,
      },
    };
    return set;
  }, {});

  // List of fields you want to remove regardless of their value
  const fieldsToRemove = [
    "next", // Replace with actual field names
    "previous",
    "children",
    "genesis_address",
    "genesis_transaction",
    "genesis_fee",
    "block",
    "content_length",
    "sat_timestamp",
    "cycle",
    "decimal",
    "epoch",
    "percentile",
    "period",
    // "rarity",
    // "sat_name",
    "sat_offset",
    "error",
    "error_retry",
    "error_tag",
    "offset",
    "sat_block_time",
    "charms",
    "domain_name",
    "domain_valid",
    "last_checked",
    "sattributes",
  ];

  console.log("Finding and preparing bulk operations...");
  console.time("findOperation");
  const documentsToUpdate = await Inscription.find(
    block ? { genesis_height: block } : query
  )
    .sort({ inscription_number: -1 })
    .limit(10000); // High limit, as per your requirement

  console.timeEnd("findOperation");
  const bulkOps = documentsToUpdate.map((doc) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: [{ $set: setQuery }, { $unset: fieldsToRemove }],
    },
  }));

  if (bulkOps.length > 0) {
    console.log(`Updating ${bulkOps.length} documents...`);
    const result = await Inscription.bulkWrite(bulkOps);
    console.log("Bulk update result:", result);
  } else {
    console.log("No documents to update.");
  }

  // End time
  console.timeEnd("cleanupOperation");
}
