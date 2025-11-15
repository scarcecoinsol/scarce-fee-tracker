// trackFeesLocked.mjs
// Daily snapshot of unclaimed Token B fees for Meteora DAMM v2 LP positions.
// - Decodes accounts using the IDL + discriminator (computed via sha256("account:" + acc.name")).
// - Computes unclaimed Token B fees for each pair.
// - Appends results to feelockdata.csv as ONE row per run:
//   Time,USDC/SCARCE,SOL/SCARCE,ETH/SCARCE,BTC/SCARCE,Total
// - Optionally pushes the same row to a Google Sheet if GSHEET_ID + GOOGLE_APPLICATION_CREDENTIALS are set.

import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { google } from "googleapis"; // Sheets API

// ---------- CONFIG ----------

// RPC endpoint
const RPC_URL =
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// Meteora DAMM v2 program ID (owner of your position accounts)
const PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
);

// Token B: SCARCE mint on all these pools
const TOKEN_B_MINT = "HmTQ5XFTJos95FraWfQ2vA2exdLHpghi9ofZL1hJb1Dt";
const TOKEN_B_DECIMALS = 6n;

// Pairs you care about (order here defines CSV/Sheet column order)
const PAIRS = [
  {
    name: "USDC/SCARCE",
    pool: "5NTgc3UVv9k4VE7dRFA9p9nwbsBwK98UqDBpWgxUpQGM",
    position: "9gv2J53nGeG1WgsuuUEszu22Qsww8DiuaxY6n9s69NvS",
  },
  {
    name: "SOL/SCARCE",
    pool: "DP6TQnxVJm8mnr8hgP1kEsGuobtPixnhXbmhCnwnhzpA",
    position: "DQbTWNmnRCTH2kYc7PTHUMFKVjKbqo6a9jDyjm5Gvyw5",
  },
  {
    name: "ETH/SCARCE",
    pool: "8Ki2eoYCg4T4u81so4FeBdD2dQV77Vw4itseVv1UGJJR",
    position: "4hFJ7VZH7iBkrk1JzvgbvjoVpHX774JjjM15jvJLrb2C",
  },
  {
    name: "BTC/SCARCE",
    pool: "8qxAav4uGykfwiVDF9rdm4hmH2uYx9d8pXrmYTqRBgt2",
    position: "GYRrMpf2LZjhqz5RHHmabNuMXSrhpDkqnvuurx8ekRZr",
  },
];

// CSV path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, "feelockdata.csv");

// Liquidity scale for U256 fixed-point math (matches on-chain LIQUIDITY_SCALE)
const LIQUIDITY_SCALE = 1n << 128n;

// ---------- LOAD IDL & SETUP ----------

const idlPath = path.join(__dirname, "idl.json");
if (!fs.existsSync(idlPath)) {
  console.error(`IDL file not found at ${idlPath}`);
  process.exit(1);
}
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
const coder = new BorshAccountsCoder(idl);
const connection = new Connection(RPC_URL, "confirmed");

// Compute account discriminator: first 8 bytes of sha256("account:<name>")
function accountDiscriminator(name) {
  const hash = crypto
    .createHash("sha256")
    .update("account:" + name)
    .digest(); // Buffer
  return hash.subarray(0, 8);
}

// Precompute discriminators for all IDL accounts
const idlAccountDiscriminators = {};
for (const acc of idl.accounts || []) {
  idlAccountDiscriminators[acc.name] = accountDiscriminator(acc.name);
}

// ---------- HELPERS ----------

// U256 (little endian bytes) -> BigInt
function u256BytesToBigInt(bytes) {
  const arr = Array.from(bytes);
  let x = 0n;
  for (let i = arr.length - 1; i >= 0; i--) {
    x = (x << 8n) + BigInt(arr[i]);
  }
  return x;
}

// Decode any Meteora account using discriminator, no need to know its name
async function decodeIdlAccountUnknown(pubkey) {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) throw new Error(`Account not found on-chain: ${pubkey.toBase58()}`);
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error(
      `Account ${pubkey.toBase58()} not owned by program ${PROGRAM_ID.toBase58()}`
    );
  }

  const disc = info.data.subarray(0, 8); // first 8 discriminator bytes

  let matchedName = null;
  for (const acc of idl.accounts || []) {
    const expectedDisc = idlAccountDiscriminators[acc.name];
    if (expectedDisc && Buffer.compare(expectedDisc, disc) === 0) {
      matchedName = acc.name;
      break;
    }
  }

  if (!matchedName) {
    throw new Error(
      `No IDL account discriminator match for ${pubkey.toBase58()}`
    );
  }

  const parsed = coder.decode(matchedName, info.data);
  return { type: matchedName, parsed };
}

// Compute unclaimed Token B fees for a position, in raw units (no decimals)
function computeUnclaimedTokenB(poolState, posState) {
  // Position liquidity = unlocked + vested + permanent_locked
  const unlocked = BigInt(posState.unlocked_liquidity.toString());
  const vested = BigInt(posState.vested_liquidity.toString());
  const permanent = BigInt(posState.permanent_locked_liquidity.toString());
  const liquidity = unlocked + vested + permanent;

  if (liquidity === 0n) return 0n;

  // Pool cumulative fee in token B per unit of liquidity (U256 LE bytes)
  const feeBPerLiquidity = u256BytesToBigInt(poolState.fee_b_per_liquidity);

  // Position checkpoint (also U256 LE bytes)
  const feeBCheckpoint = u256BytesToBigInt(
    posState.fee_b_per_token_checkpoint
  );

  // Already cached pending fees in token B (u64 / BN)
  const feeBPending = BigInt(posState.fee_b_pending.toString());

  let delta = feeBPerLiquidity - feeBCheckpoint;
  if (delta < 0n) delta = 0n;

  // new_fee = liquidity * (delta / 2^128)
  const newlyAccrued = (liquidity * delta) / LIQUIDITY_SCALE;
  const totalPending = newlyAccrued + feeBPending;

  return totalPending;
}

// Ensure CSV has header row: Time,USDC/SCARCE,SOL/SCARCE,ETH/SCARCE,BTC/SCARCE,Total
function ensureCsvHeader() {
  if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) {
    const header =
      "time," + PAIRS.map((p) => p.name).join(",") + ",Total\n";
    fs.writeFileSync(CSV_PATH, header);
  }
}

// Append ONE combined row to CSV: time + all pools + total
function appendCsvCombinedRow(timestampIso, perPairTokens, totalTokens) {
  // ensure order matches PAIRS
  const cols = PAIRS.map((p) =>
    perPairTokens[p.name] !== undefined ? perPairTokens[p.name] : 0
  );
  const line =
    timestampIso +
    "," +
    cols.join(",") +
    "," +
    totalTokens +
    "\n";
  fs.appendFileSync(CSV_PATH, line);
}

// ---------- GOOGLE SHEETS CLIENT (from your snippet) ----------

async function getSheetsClient() {
  const sheetId = process.env.GSHEET_ID;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!sheetId) {
    console.warn("GSHEET_ID env variable not set. Sheet updates will be skipped.");
    return null;
  }
  if (!credsPath) {
    console.warn("GOOGLE_APPLICATION_CREDENTIALS env variable not set. Sheet updates will be skipped.");
    return null;
  }

  let creds;
  try {
    const raw = fs.readFileSync(credsPath, "utf8");
    creds = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to read service account JSON:", e.message);
    return null;
  }

  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes
  );

  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, sheetId };
}

// Append ONE combined row to Google Sheet: time + all pools + total
async function appendSheetCombinedRow(timestampIso, perPairTokens, totalTokens) {
  const client = await getSheetsClient();
  if (!client) return;

  const { sheets, sheetId } = client;

  const cols = PAIRS.map((p) =>
    perPairTokens[p.name] !== undefined ? perPairTokens[p.name] : 0
  );

  const values = [[timestampIso, ...cols, totalTokens]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "A:F", // Time + 4 pools + Total
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

// ---------- MAIN DAILY SNAPSHOT ----------

async function processPair(pair) {
  const poolPk = new PublicKey(pair.pool);
  const posPk = new PublicKey(pair.position);

  // Decode both accounts (type-agnostic)
  const poolDecoded = await decodeIdlAccountUnknown(poolPk);
  const posDecoded = await decodeIdlAccountUnknown(posPk);

  // Identify which is pool vs position by presence of pool-only field
  let poolState = poolDecoded.parsed;
  let posState = posDecoded.parsed;

  if (!("fee_b_per_liquidity" in poolState)) {
    // swap if we guessed wrong
    if (!("fee_b_per_liquidity" in posState)) {
      throw new Error(
        `Neither decoded account for ${pair.name} looks like Pool (missing fee_b_per_liquidity)`
      );
    }
    [poolState, posState] = [posState, poolState];
  }

  if (!("fee_b_per_token_checkpoint" in posState)) {
    throw new Error(
      `Decoded position account for ${pair.name} missing fee_b_per_token_checkpoint`
    );
  }

  const totalPendingRaw = computeUnclaimedTokenB(poolState, posState);
  const totalPendingTokens =
    Number(totalPendingRaw) / 10 ** Number(TOKEN_B_DECIMALS);

  return { totalPendingRaw, totalPendingTokens };
}

async function main() {
  const now = new Date();
  const timestampIso = now.toISOString();
  console.log(`[${timestampIso}] Running daily fee snapshot...`);

  ensureCsvHeader();

  // per-pair values in human units (Token B with 6 decimals applied)
  const perPairTokens = {};
  let totalRaw = 0n;

  for (const pair of PAIRS) {
    try {
      const { totalPendingRaw, totalPendingTokens } = await processPair(pair);

      totalRaw += totalPendingRaw;

      const deltaRaw = totalPendingRaw; // snapshot ≈ amount locked
      const deltaTokens =
        Number(deltaRaw) / 10 ** Number(TOKEN_B_DECIMALS);

      perPairTokens[pair.name] = deltaTokens;

      console.log(`\n=== ${pair.name} ===`);
      console.log(`Unclaimed Token B (raw): ${totalPendingRaw.toString()}`);
      console.log(
        `Unclaimed Token B (${TOKEN_B_DECIMALS} dp): ${totalPendingTokens.toLocaleString(
          "en-US"
        )} tokens`
      );
    } catch (e) {
      console.error(`Error processing ${pair.name}: ${e.message || e}`);
      perPairTokens[pair.name] = 0;
    }
  }

  const totalTokens =
    Number(totalRaw) / 10 ** Number(TOKEN_B_DECIMALS);

  console.log(`\n============================================`);
  console.log(`Row summary @ ${timestampIso}`);
  console.log(
    `USDC/SCARCE: ${perPairTokens["USDC/SCARCE"] ?? 0}, ` +
      `SOL/SCARCE: ${perPairTokens["SOL/SCARCE"] ?? 0}, ` +
      `ETH/SCARCE: ${perPairTokens["ETH/SCARCE"] ?? 0}, ` +
      `BTC/SCARCE: ${perPairTokens["BTC/SCARCE"] ?? 0}`
  );
  console.log(`TOTAL Unclaimed Token B: ${totalTokens} tokens`);
  console.log(`Token B mint: ${TOKEN_B_MINT}`);
  console.log(`============================================`);

  // Append combined row to CSV
  appendCsvCombinedRow(timestampIso, perPairTokens, totalTokens);

  // Append combined row to Google Sheet (if configured)
  try {
    await appendSheetCombinedRow(timestampIso, perPairTokens, totalTokens);
    console.log("Google Sheet updated.");
  } catch (e) {
    console.error("Failed to update Google Sheet:", e.message || e);
  }

  console.log("Daily run completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
