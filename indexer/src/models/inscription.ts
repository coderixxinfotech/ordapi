import mongoose, { Schema } from "mongoose";

const attributeSchema = new Schema({
  trait_type: { type: String, required: true },
  value: { type: String, required: true },
});

// Define the main schema
export const inscriptionSchema = new mongoose.Schema(
  {
    inscription_number: { type: Number, unique: true, required: true },
    inscription_id: {
      type: String,
      unique: true,
      required: true,
      validate: {
        validator: (value: string) => /^[a-f0-9]+i\d+$/.test(value),
        message: () =>
          "inscription_id should be in the format: c17dd02a7f216f4b438ab1a303f518abfc4d4d01dcff8f023cf87c4403cb54cai0",
      },
    },
    content: { type: String },
    sha: {
      type: String,
      sparse: true,
      validate: {
        validator: (value: string) => /^[a-f0-9]+$/.test(value),
        message: () => "sha should consist of hexadecimal characters only.",
      },
    },
    location: {
      type: String,
      validate: {
        validator: (value: string) => /^[\da-f]+:\d+:\d+$/.test(value),
        message: () => "location should have two ':' followed by numbers.",
      },
    },
    output: {
      type: String,
      validate: {
        validator: (value: string) => /^[\da-f]+:\d+$/.test(value),
        message: () => "output should have one ':' followed by a number.",
      },
    },
    timestamp: {
      type: Date,
    },
    // children: { type: Array },
    // next: { type: String },
    // previous: { type: String },
    parent: { type: String },

    delegate: { type: String },
    // genesis_address: { type: String },
    // genesis_fee: { type: Number },
    genesis_height: { type: Number, index: true },
    // genesis_transaction: { type: String },
    // flagged: { type: Boolean },
    // banned: { type: Boolean },
    // reason: { type: String },
    // updated_by: { type: String },
    // block: { type: Number },
    content_length: { type: Number },
    content_type: { type: String },
    // collection detail
    official_collection: {
      type: Schema.Types.ObjectId,
      ref: "Collection",
      sparse: true,
    },
    collection_item_name: { type: String, set: (v: string) => v.trim() },
    collection_item_number: { type: Number },
    attributes: { type: [attributeSchema] },
    // sat details

    // sat_timestamp: {
    //   type: Date,
    // },
    // cycle: { type: Number },
    // decimal: { type: String },
    // degree: { type: String },
    // epoch: { type: Number },
    // percentile: { type: String },
    // period: { type: Number },
    // rarity: { type: String },
    sat: { type: String },
    // sat_name: { type: String },
    // sat_offset: { type: Number },
    // lists: [{ type: Schema.Types.ObjectId, ref: "Collection" }],
    tags: {
      type: Array,
      required: false,
      validate: {
        validator: function (tags: any[]) {
          const pattern = /^[^A-Z]+$/;
          return tags.every((tag) => pattern.test(tag));
        },

        message: () =>
          `Tags should only contain lowercase letters and hyphens.`,
      },
    },
    // error: {
    //   type: Boolean,
    //   default: false,
    //   validate: {
    //     validator: function (this: any, value: boolean) {
    //       if (value) console.log(this.inscription_id, "error here");
    //       return !value || (value === true && !!this.error_tag);
    //     },
    //     message: 'If "error" is set to true, "error_tag" must be provided.',
    //   },
    // },
    // error_retry: { type: Number, default: 0 },
    // error_tag: { type: String, default: null },
    offset: { type: Number },
    output_value: { type: Number },
    address: {
      type: String,
      validate: {
        validator: function (this: any, value: string) {
          return (
            !value ||
            (value &&
              this.output &&
              this.location &&
              this.output_value !== null)
          );
        },
        message:
          'If "address" is provided, "output", "location", and "output_value" must also be provided.',
      },
    },

    // Listings
    listed: {
      type: Boolean,
      validate: {
        validator: function (this: any, value: boolean) {
          return (
            !value ||
            (value &&
              this.listed_at &&
              this.listed_price &&
              this.listed_maker_fee_bp &&
              this.tap_internal_key &&
              this.listed_seller_receive_address &&
              this.signed_psbt &&
              this.unsigned_psbt)
          );
        },
        message:
          'If "listed" is true, all related "listed_" fields must also be provided.',
      },
    },
    listed_at: { type: Date },
    listed_price: { type: Number }, // in sats
    listed_price_per_token: { type: Number }, //in sats
    listed_token: { type: String },
    listed_amount: { type: Number },
    listed_maker_fee_bp: { type: Number },
    tap_internal_key: { type: String, set: (v: string) => v.trim() },
    listed_seller_receive_address: { type: String },
    signed_psbt: { type: String },
    unsigned_psbt: { type: String },
    in_mempool: { type: Boolean, default: false },
    txid: { type: String },
    // sat_block_time: { type: Date },
    // sattributes: [{ type: String }],
    // last_checked: { type: Date },
    version: { type: Number },
    token: { type: Boolean },
    // domain_name: { type: String, set: (v: string) => v.trim() },
    // domain_valid: { type: Boolean },

    // new fields (metadata + metaprotocols)
    // charms: { type: Number },
    charms_array: { type: [String] },
    // transfer_valid: { type: Boolean },
    metaprotocol: { type: String },
    parsed_metaprotocol: {
      type: [String],
      set: function (value: string) {
        // Check if the value is a string and not empty
        if (typeof value === "string" && value.trim().length > 0) {
          // Split the string by a delimiter (e.g., comma), trim and convert each part to lowercase
          return value.split(":").map((item) => item.trim().toLowerCase());
        } else {
          return [];
        }
      },
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    valid: { type: Boolean },
  },
  {
    minimize: true,
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// Define optimized indexes

// Inscription search indexes
inscriptionSchema.index({ inscription_number: 1 });
inscriptionSchema.index({ inscription_number: -1 });
inscriptionSchema.index({ inscription_id: 1 }, { unique: true });
inscriptionSchema.index({ content: "text" });

// address token search
inscriptionSchema.index(
  { address: 1, parsed_metaprotocol: 1, valid: 1 },
  { sparse: true }
);

// address collection search
inscriptionSchema.index(
  { address: 1, official_collection: 1 },
  { sparse: true }
);

// listed token search
inscriptionSchema.index(
  {
    listed_token: 1,
    valid: 1,
    parsed_metaprotocol: 1,
    listed_price: 1,
    listed_price_per_token: 1,
  },
  { sparse: true }
);

// listed collection search

inscriptionSchema.index(
  {
    "attributes.value": 1,
    "attributes.trait_type": 1,
    official_collection: 1,
    inscription_number: 1,
    listed: 1,
    collection_item_name: 1,
    collection_item_number: 1,
  },
  { sparse: true }
);

// pending listings search
inscriptionSchema.index({ txid: 1, in_mempool: 1 }, { sparse: true });

// sha version search
inscriptionSchema.index(
  { sha: 1, version: 1, inscription_number: 1 },
  { sparse: true }
);

// custom. temp.
inscriptionSchema.index({ sha: 1, inscription_number: -1 })

