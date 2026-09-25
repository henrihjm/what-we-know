import { nimbleExtract } from "../nimble.js";

/** Generic page via Nimble extract (rendered). Returns markdown text. */
export async function fetchPage(url: string): Promise<string> {
  return nimbleExtract(url);
}
