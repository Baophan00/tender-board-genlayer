import fs from "fs";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
const addr = process.argv[2];
const c = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const list = await c.readContract({ address: addr, functionName: "list_tenders", args: [0, 10] });
for (const t of list) {
  console.log(t.id, t.status, "bids", t.bids, "scored", t.scored, "winner", t.winner || "-");
  const bids = await c.readContract({ address: addr, functionName: "bids_of", args: [t.id] });
  for (const b of bids) console.log("   bid", b.seq, "revealed", b.revealed, "bucket", b.bucket || "-", "total", b.total);
}
