import moment from "moment";
import axios from "axios";
import { IInscription } from "../types";
export default async function fetchContentFromProviders(contentId: string) {
  try {
    const url = `${process.env.PROVIDER}/content/${contentId}`;
    const response = await axios.get(url, {
      responseType: "arraybuffer",
    });
    return response;
  } catch (error: any) {
    // console.log(error);
    // console.log("err fetching content: ", contentId);
    return null;
    // throw Error("Err Fetching Content: " + contentId);
  }
}



export async function fetchInscriptionDetails(
  inscriptionId: string,
  provider?: string
): Promise<
  Partial<IInscription> | { error: true; error_tag: string; error_retry: 1 }
> {
  try {
    const { data } = await axios.get(
      `${provider || process.env.PROVIDER}/api/inscription/${inscriptionId}`,
      { headers: { Accept: "application/json" } }
    );
    if (!data) {
      if (
        !data.inscription_number &&
        !data.genesis_height
      )
        throw Error("server down");
    }

    return {
      ...data,
      timestamp: moment.unix(data.timestamp),
      location: data.satpoint,
    };
  } catch (error: any) {
    if (
      error.response &&
      (error.response.status === 500 || error.response.status === 502)
    ) {
      return { error: true, error_tag: "server error", error_retry: 1 };
    }
    throw error;
  }
}
