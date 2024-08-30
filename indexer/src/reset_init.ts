import dbConnect from "./lib/dbConnect";
import { OrdIndexerVersion, OrdNetworkType } from "./models";

export const initializeDB = async () => {
  await dbConnect()
  const networkType = process.env.NETWORK_TYPE || "mainnet";
  const DB_VERSION = 1;
  const INDEXER_VERSION = 1;
  const ORD_VERSION = "0.18.5";
    try {
      await OrdNetworkType.create({ network_type: networkType });
      await OrdIndexerVersion.create({ db_version: DB_VERSION, indexer_version: INDEXER_VERSION, ord_version: ORD_VERSION });
      console.log(`Initialized RunesNetworkType with network_type: ${networkType}`);
    } catch (error) {
      console.error('Error initializing database:', error);
      process.exit(1);
    }
};
