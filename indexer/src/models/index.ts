import mongoose, { Document, models, model, Schema } from 'mongoose';
import { inscriptionSchema } from './inscription';

interface IOrdIndexerVersion extends Document {
  db_version: number;
  indexer_version: number;
  ord_version: string;
}

interface IOrdNetworkType extends Document {
  network_type: string;
}

interface IBlockHashes extends Document {
  block_height: number;
  blockhash: string;
}

// Define the schema for the ReorgStat collection
const ReorgStatSchema = new Schema({
  reorg_tm: {
    type: Number,
    required: true,
    description: "Time taken to handle the reorg in milliseconds."
  },
  old_block_height: {
    type: Number,
    required: true,
    description: "The block height before the reorg was handled."
  },
  new_block_height: {
    type: Number,
    required: true,
    description: "The block height after the reorg was handled (should be one block before the detected reorg)."
  },
  created_at: {
    type: Date,
    default: Date.now,
    description: "Timestamp when the reorg stat was created."
  }
});

const OrdIndexerVersionSchema: Schema = new Schema({
  db_version: { type: Number, required: true },
  indexer_version: { type: Number, required: true },
  ord_version: { type: String, required: true }
});

const OrdNetworkTypeSchema: Schema = new Schema({
  network_type: { type: String, required: true }
});

const BlockHashesSchema: Schema = new Schema({
  block_height: { type: Number, required: true, unique: true },
  blockhash:{type: String, required: true}
});




const OrdIndexerVersion = mongoose.model<IOrdIndexerVersion>('OrdIndexerVersion', OrdIndexerVersionSchema);
const OrdNetworkType = mongoose.model<IOrdNetworkType>('OrdNetworkType', OrdNetworkTypeSchema);
const BlockHashes = mongoose.model<IBlockHashes>('BlockHashes', BlockHashesSchema);
const Inscription =
  models.Inscription || model("Inscription", inscriptionSchema);

// Create the ReorgStat model using the schema
const ReorgStat = mongoose.model('ReorgStat', ReorgStatSchema);

export {OrdIndexerVersion, OrdNetworkType, BlockHashes, Inscription, ReorgStat}
