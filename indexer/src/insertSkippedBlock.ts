import dbConnect from "./lib/dbConnect"
import { BlockHashes, Inscription } from "./models";
import axios from 'axios';
import fetchContentFromProviders, { fetchInscriptionDetails } from "./utils";
import crypto from "crypto"

export async function InsertSkippedBlock(block: number){
 try{
    await dbConnect();
    await checkPrevBlock(block);

    console.log("checked prev block")

  // previous block's inscriptions are present in DB
  // Let's add this blocks inscriptions

  const url = `${process.env.PROVIDER}/block/${block}`;

//   console.log({ url });

  const result = await axios.get(url, {
    headers: { Accept: "application/json" },
  });

  const data = result.data;
  console.log({data})

if(data.inscriptions.length){


    // Fetch existing inscriptions from the database
    const existingInscriptions = await Inscription.find({
      inscription_id: { $in: data.inscriptions },
    }).select("inscription_id");

        // Convert to a set for faster lookup
    const existingSet = new Set(
      existingInscriptions.map(
        (inscription: { inscription_id: string }) => inscription.inscription_id
      )
    );



    // Filter out inscriptions that already exist in the database
    const filteredInscriptions = data.inscriptions.filter(
      (inscription: string) => !existingSet.has(inscription)
    );

    if (!filteredInscriptions.length) {      
    await BlockHashes.create({block_height: block, blockhash: data.hash})
    }


    const batchSize = 500;
    let bulkOps:any = []
    for (let i = 0; i < filteredInscriptions.length; i += batchSize) {
      // Extract a slice of 500 items at a time

      // console.log(`BULKOPS items: ${bulkOps.length}`);
      const selected = filteredInscriptions.slice(i, i + batchSize);

      // Call the function with the current batch
      await processSingleBatch(selected, bulkOps);
      // await wait(2);

      console.log("Processed: ", bulkOps.length);
    }


    // Sort the bulkOps array based on the 'number' field in ascending order
    bulkOps.sort((a: any, b: any) => {
      return (
        a.updateOne.update.$set.inscription_number -
        b.updateOne.update.$set.inscription_number
      );
    });



    // console.log("Starting transformation checks...");
    const transformedBulkDocs = await handlePreSaveLogic(bulkOps);

    // console.log(`After Transforming ${transformedBulkDocs.length} DAta`);
    const bulkWriteOperations = transformedBulkDocs.map((transformedDoc) => {
      return {
        updateOne: {
          filter: { inscription_id: transformedDoc.inscription_id }, // or whatever your unique identifier is
          update: { $set: transformedDoc },
          upsert: true,
        },
      };
    });

    if (bulkWriteOperations.length > 0)
     {
         await Inscription.bulkWrite(bulkWriteOperations);
         // verify
         if(await Inscription.countDocuments({genesis_height: block})===data.inscriptions.length){
            await BlockHashes.create({block_height: block, blockhash: data.hash})
         }
        }

}else{
    await BlockHashes.create({block_height: block, blockhash: data.hash})
}

  

// await cleanup()

 }
 catch(e: any){
    throw Error(e)
 }   
}


const processSingleBatch = async (inscriptions: string[], bulkOps: any) => {
  // console.log(`started processing ${inscriptions.length} inscriptions`);
  const batchPromises = inscriptions.map((inscription_id) =>
    processInscription(inscription_id, bulkOps)
  );

  await Promise.allSettled(batchPromises);
};

const processInscription = async (inscription_id: string, bulkOps: any) => {
  if (!inscription_id) return;
  let tags: string[] = [];
  let content = null;
  let sha;
  let token = false;
  let contentType = null;
  let contentResponse = null;
  try {
    contentResponse = await fetchContentFromProviders(inscription_id);
    contentType = contentResponse
      ? contentResponse.headers["content-type"]
      : null;

    if (contentResponse) {
      if (/text|html|json|javascript/.test(contentType)) {
        content = contentResponse.data;

        try {

          if (content.startsWith("cbrc-20:")) {
            tags.push("cbrc");
            tags.push("token");
            token = true;
          }
          const parsedContent = JSON.parse(content.toString("utf-8"));

          if (parsedContent.p === "brc-20") {
            tags.push("brc-20");
            tags.push("token");
            token = true;
          }
          else if (
            parsedContent.p === "sns" ||
            parsedContent.p.includes("sns")
          ) {
            tags.push("token");
            token = true;
          }  else if (
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
        } catch (error) {}

        if (!token) {
          // if content is not a token
          if (typeof content === "object") {
            content = contentResponse.data.toString("utf-8");
          }
          // handle multiple tap mints like inscription 46225391
          if (
            content.includes(`"p":`) &&
            content.includes(`"op":`) &&
            (content.includes(`"tick":`) || content.includes(`"amt":`))
          ) {
            if (!tags.includes("token")) tags.push("token");
            token = true;
          }

        //   if (!token)
            sha = crypto
              .createHash("sha256")
              .update(content, "utf8")
              .digest("hex");
        }
      } else if (!token && !/video|audio/.test(contentType)) {
        // if content is not a token or video/audio
        sha = crypto
          .createHash("sha256")
          .update(contentResponse.data)
          .digest("hex");
      }
    }
  } catch (e) {}

  let inscriptionDetails: any = {};
  inscriptionDetails = await fetchInscriptionDetails(inscription_id);

  if (!inscriptionDetails) {
    throw Error("inscription details not found");
  }
  tags = tags.filter((tag) => tag).map((tag) => tag.toLowerCase());

  if (inscriptionDetails.metadata)
    inscriptionDetails.metadata = new Map(
      Object.entries(inscriptionDetails.metadata)
    );

  if (
    inscriptionDetails.metaprotocol &&
    inscriptionDetails.metaprotocol?.startsWith("cbrc-20")
  ) {
    token = true;
    tags.push("token");
    tags.push("cbrc");
  }
  if (inscriptionDetails.metaprotocol)
    inscriptionDetails.parsed_metaprotocol = inscriptionDetails?.metaprotocol;

  const content_ =
    (contentResponse && contentResponse.data.toString("utf-8")) || "";
  const truncatedContent =
    content_.length > 15000 ? content_.substring(0, 15000) : content_;

  const inscriptionDoc = {
    inscription_id,
    inscription_number: inscriptionDetails.inscription_number,
    address: inscriptionDetails.address,
    content_type: contentType,
    genesis_height: inscriptionDetails.genesis_height,
    ...(inscriptionDetails.charms.length > 0 && {
      charms_array: inscriptionDetails.charms,
    }),
    sat: inscriptionDetails.sat,
    ...((token && !tags.includes("cbrc")) ||
    !contentResponse ||
    !sha ||
    /image|audio|zip|video/.test(contentType)
      ? {}
      : { content: truncatedContent }),
    // ...(sha &&
    //   (!inscriptionDetails.metaprotocol ||
    //     !inscriptionDetails.metaprotocol.includes("transfer")) && {
    //     sha,
    //   }),
    ...(token && { token }),
    tags,
    ...inscriptionDetails,
    charms: 0,
  };

  if (!inscriptionDoc.genesis_height) {
    console.dir(inscriptionDoc, { depth: null });
    throw Error("GENESIS HEIGHT MISSING");
  }
  bulkOps.push({
    updateOne: {
      filter: {
        inscription_id,
      },
      update: { $set: inscriptionDoc },
      upsert: true,
    },
  });
};

export const handlePreSaveLogic = async (bulkDocs: Array<Partial<any>>) => {

    console.log({bulkDocs: bulkDocs.length})
  const transformedBulkOps: any[] = [];


  // Pre-compute the maximum existing version for each unique SHA
//   const uniqueShas = [
//     ...new Set(insertOps.map((doc:any) => doc.updateOne.update.$set.sha)),
//   ];

 
//   const latestDocumentsWithSameShas = await Inscription.aggregate([
//   {
//     $match: {
//       sha: { $in: uniqueShas },
//     },
//   },
//   {
//     $sort: { sha: 1, version: -1 }, // Sort by sha and then by version descending
//   },
//   {
//     $group: {
//       _id: "$sha", // Group by sha
//       doc: { $first: "$$ROOT" }, // Get the first document in each group (i.e., the one with the highest version)
//     },
//   },
//   {
//     $replaceRoot: { newRoot: "$doc" }, // Replace the root with the document itself
//   },
// ]);

//   console.log(`total unique shas... ${uniqueShas.length}`)
//   console.log('total docs found in db with same sha...', latestDocumentsWithSameShas.length)

//   for (const sha of uniqueShas) {
//     if (sha) {
//       const latestDocumentWithSameShaMatch = latestDocumentsWithSameShas.filter(a=>a.sha === sha);

//       if(latestDocumentWithSameShaMatch.length>1){
//         throw Error("Multiple docs with same sha received");
//       }
//       const latestDocumentWithSameSha = latestDocumentWithSameShaMatch[0]
//       //@ts-ignore
//       shaMap[sha] = latestDocumentWithSameSha
//         ? latestDocumentWithSameSha.version
//         : 0;
//     }
//   }


  for (let i = 0; i < bulkDocs.length; i++) {
    let bulkDoc = { ...bulkDocs[i] };
    const updateOne = bulkDoc.updateOne;
    const doc = updateOne.update.$set;


    if (i === 0 && doc.inscription_number > 0) {
      const prevDocument = await Inscription.findOne({
        inscription_number: doc.inscription_number - 1,
      });

      if (!prevDocument || !prevDocument.inscription_id) {
        await BlockHashes.deleteOne({block_height: doc.genesis_height - 1});
        await Inscription.deleteMany({genesis_height: doc.genesis_height - 1})
        await InsertSkippedBlock(doc.genesis_height - 1)
        throw new Error(
          `1) A document with number ${
            doc.inscription_number - 1
          } does not exist or inscriptionId is missing in it`
        );
      }
    } else if (i > 0) {

    const lastDoc = bulkDocs[i-1].updateOne.update.$set;
    if (doc.inscription_number !== lastDoc.inscription_number + 1) {
      throw new Error(
        `2) The inscription_number for document at position ${i} is not consecutive. Expected ${
          lastDoc.inscription_number + 1
        }, but got ${doc.inscription_number}`
      );
    }
  }

    // Updated SHA version logic
    // if (doc.sha && !doc.token) {
    //   if (shaMap[doc.sha] != null) {
    //     shaMap[doc.sha]++;
    //   } else {
    //     shaMap[doc.sha] = 1;
    //   }
    //   doc.version = shaMap[doc.sha];
    // }

    if (doc.content_type && doc.content_type.includes("/")) {
      const contentTypeParts = doc.content_type.split("/");
      doc.tags = doc.tags
        ? [
            ...doc.tags
              .filter((tag: string) => tag)
              .map((tag: string) => tag.toLowerCase()),
            ...contentTypeParts
              .filter((part: string) => part)
              .map((part: string) => part.toLowerCase()),
          ]
        : contentTypeParts
            .filter((part: string) => part)
            .map((part: string) => part.toLowerCase());
    }
    transformedBulkOps.push(doc);
  }

  // console.debug(shaMap, "SHAMAP");
  return transformedBulkOps;
};

async function checkPrevBlock(block: number){

    // make sure previous block data is complete;
    const inscriptionsOfThisBlockInDB = await Inscription.countDocuments({genesis_height : block-1});

      if (!inscriptionsOfThisBlockInDB) 
  throw Error("This BLOCK is messed up: "+block)

  const url = `${process.env.PROVIDER}/block/${block - 1}`;

//   console.log({ url });

  const result = await axios.get(url, {
    headers: { Accept: "application/json" },
  });

  const data = result.data;


  if(inscriptionsOfThisBlockInDB>0 && inscriptionsOfThisBlockInDB != data.inscriptions.length)
  {  await Inscription.deleteMany({genesis_height: block-1})

  throw Error("This BLOCK is messed up: "+block)
}


  return;
}