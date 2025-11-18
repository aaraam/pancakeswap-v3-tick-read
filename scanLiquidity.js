// scanLiquidity.js
import "dotenv/config";
import { JsonRpcProvider, Contract } from "ethers";

// ---------- CONFIG ----------
const RPC_URL = process.env.BSC_RPC_URL;
if (!RPC_URL) {
  console.error("Missing BSC_RPC_URL in .env");
  process.exit(1);
}

const POOL_ADDRESS = process.env.POOL; 

// Minimal V3 pool ABI
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function tickBitmap(int16 wordPosition) view returns (int256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)"
];

// Minimal ERC20 ABI for decimals + symbol
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// ---------- HELPERS ----------

// Tick -> word / bit pos in bitmap
function getWordPosAndBitPos(tickBigInt, tickSpacingBigInt) {
  const ts = BigInt(tickSpacingBigInt);

  let compressed = tickBigInt / ts;
  if (tickBigInt < 0n && tickBigInt % ts !== 0n) {
    compressed -= 1n; // match Solidity div toward -inf
  }

  const wordPos = Number(compressed >> 8n);      // / 256
  const bitPos = Number(compressed & 255n);      // % 256
  return { wordPos, bitPos };
}

// From bitmap -> list of initialized tick indices in that word
function getInitializedTicksFromBitmap(bitmapBigInt, baseWordIndex, tickSpacingBigInt) {
  const ticks = [];
  const ts = BigInt(tickSpacingBigInt);
  let bitmap = bitmapBigInt;

  for (let bit = 0; bit < 256; bit++) {
    const mask = 1n << BigInt(bit);
    if ((bitmap & mask) !== 0n) {
      // tick = (wordIndex * 256 + bit) * tickSpacing
      const tickIndex = BigInt(baseWordIndex * 256 + bit) * ts;
      ticks.push(Number(tickIndex)); // safe range for our use case
    }
  }
  return ticks;
}

// Tick -> sqrtPriceX96 (approx, but good enough for step-size estimation)
function tickToSqrtPriceX96(tick) {
  const ratio = Math.pow(1.0001, tick);     // P = 1.0001^tick
  const sqrtP = Math.sqrt(ratio);           // sqrt(P)
  const sqrtX96 = sqrtP * 2 ** 96;
  return BigInt(Math.floor(sqrtX96));
}

// Format BigInt token amount using decimals -> human readable number
function formatUnits(rawBigInt, decimals, maxFrac = 6) {
  const n = Number(rawBigInt); // precision loss is fine for display
  const d = Number(decimals);  // ethers v6 uint8 is bigint
  const val = n / 10 ** d;
  return val.toLocaleString("en-IN", {
    maximumFractionDigits: maxFrac
  });
}

// ---------- MAIN ----------
async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const pool = new Contract(POOL_ADDRESS, POOL_ABI, provider);

  console.log(`Reading pool state: ${POOL_ADDRESS}`);

  const [token0Addr, token1Addr, fee, tickSpacing, liquidity, slot0] =
    await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.tickSpacing(),
      pool.liquidity(),
      pool.slot0()
    ]);

  const currentTick = slot0.tick;          // BigInt
  const sqrtPriceX96 = slot0.sqrtPriceX96; // BigInt

  // Fetch token metadata
  const token0 = new Contract(token0Addr, ERC20_ABI, provider);
  const token1 = new Contract(token1Addr, ERC20_ABI, provider);

  const [dec0, sym0, dec1, sym1] = await Promise.all([
    token0.decimals(),
    token0.symbol(),
    token1.decimals(),
    token1.symbol()
  ]);

  console.log("token0:", token0Addr, `(${sym0}, decimals=${dec0})`);
  console.log("token1:", token1Addr, `(${sym1}, decimals=${dec1})`);
  console.log("fee (hundredths of a bip):", fee.toString());
  console.log("tickSpacing:", tickSpacing.toString());
  console.log("currentTick:", currentTick.toString());
  console.log("sqrtPriceX96:", sqrtPriceX96.toString());
  console.log("pool liquidity (L):", liquidity.toString());

  // Approx current price token1 per token0 for intuition only
  const sqrtPFloat = Number(sqrtPriceX96) / 2 ** 96;
  const price = sqrtPFloat * sqrtPFloat;
  console.log(`approx price (token1 per token0): ~${price}`);

  // ----- Scan initialized ticks around current price -----
  const { wordPos: baseWordPos, bitPos: baseBitPos } =
    getWordPosAndBitPos(currentTick, tickSpacing);
  console.log("baseWordPos:", baseWordPos, "baseBitPos:", baseBitPos);

  const WORD_RANGE = 10; // words around current tick

  const initializedTicks = [];

  for (let offset = -WORD_RANGE; offset <= WORD_RANGE; offset++) {
    const wordIndex = baseWordPos + offset;
    const bitmap = await pool.tickBitmap(wordIndex);
    if (bitmap === 0n) continue;

    const ticksInWord = getInitializedTicksFromBitmap(
      bitmap,
      wordIndex,
      tickSpacing
    );

    for (const t of ticksInWord) {
      const tickData = await pool.ticks(t);
      if (!tickData.initialized) continue;

      initializedTicks.push({
        tickIndex: t,
        liquidityGross: tickData.liquidityGross,
        liquidityNet: tickData.liquidityNet
      });
    }
  }

  initializedTicks.sort((a, b) => a.tickIndex - b.tickIndex);

  console.log("\nInitialized ticks around current price:");
  for (const t of initializedTicks) {
    console.log(
      `tick ${t.tickIndex.toString().padStart(6, " ")} | ` +
        `gross=${t.liquidityGross.toString()} | net=${t.liquidityNet.toString()}`
    );
  }
  console.log(`Total initialized ticks: ${initializedTicks.length}`);

  // ----- Find next tick up / down -----
  const ct = Number(currentTick);

  const nextTickUp = initializedTicks
    .map(t => t.tickIndex)
    .filter(t => t > ct)
    .sort((a, b) => a - b)[0];

  const nextTickDown = initializedTicks
    .map(t => t.tickIndex)
    .filter(t => t < ct)
    .sort((a, b) => b - a)[0];

  console.log("\n=== PRICE MOVE ESTIMATOR (one-tick step) ===");
  console.log("Next tick UP:   ", nextTickUp);
  console.log("Next tick DOWN: ", nextTickDown);

  if (nextTickUp === undefined || nextTickDown === undefined) {
    console.log("Not enough surrounding ticks to estimate both directions.");
    return;
  }

  const L = liquidity;                // BigInt
  const sqrtP = sqrtPriceX96;         // BigInt
  const sqrtPUp = tickToSqrtPriceX96(nextTickUp);
  const sqrtPDown = tickToSqrtPriceX96(nextTickDown);
  const Q96 = 2n ** 96n;

  // amount1 (token1 in) to move UP one tick:
  // amount1 = L * (sqrtPUp - sqrtP) / Q96
  const amount1UpRaw = (L * (sqrtPUp - sqrtP)) / Q96;

  // amount0 (token0 in) to move DOWN one tick:
  // amount0 = L * Q96 * (sqrtP - sqrtPDown) / (sqrtP * sqrtPDown)
  const num0 = L * Q96 * (sqrtP - sqrtPDown);
  const den0 = sqrtP * sqrtPDown;
  const amount0DownRaw = num0 / den0;

  console.log(
    `\n${sym1} NEEDED (token1) to push price UP to next tick (${nextTickUp}):`
  );
  console.log(`≈ ${formatUnits(amount1UpRaw, dec1)} ${sym1}`);

  console.log(
    `\n${sym0} NEEDED (token0) to push price DOWN to next tick (${nextTickDown}):`
  );
  console.log(`≈ ${formatUnits(amount0DownRaw, dec0)} ${sym0}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
