//@ts-nocheck
import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

console.log(MONGODB_URI, "URI");
if (!MONGODB_URI) {
  throw new Error(
    "Please define the MONGODB_URI environment variable inside .env.local"
  );
}

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function dbConnect() {
  if (cached.conn) {
    // console.log("returning cached db conn");
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }
  cached.conn = await cached.promise;
  if (cached.conn) console.log("connected to DB");
  else {
    console.log("didnt connect");
  }
  return cached.conn;
}

export default dbConnect;
