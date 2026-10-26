import type { Site } from "../../../src/plugin/optimizer/facts.js";

/** Lists `sites` depth-first, each before its nested sites. */
export function flattenSites(sites: readonly Site[]): Site[] {
  return sites.flatMap((site) => [site, ...flattenSites(site.nested)]);
}
