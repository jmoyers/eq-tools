// =============================================================================
// infra/build.mjs — bundle the submit handler into a DETERMINISTIC Lambda zip.
// =============================================================================
//
//     node infra/build.mjs        ->  infra/dist/submit.mjs + infra/dist/submit.zip
//
// WHY THIS EXISTS. The handler imports `validateSubmit` from
// src/shared/feedback.ts, so the server runs the SAME validator as the dialog and
// the main process. That import only survives if something bundles it, and the
// owner chose Terraform (which brings no build step of its own). So: esbuild,
// which is already in this tree, driven by 120 lines we own.
//
// EVERYTHING IS BUNDLED, including the AWS SDK and the postgres driver. The
// Lambda Node runtimes do ship an SDK v3, but WHICH packages and WHICH version is
// AWS's business, not ours — `@aws-sdk/s3-presigned-post` and
// `@aws-sdk/dsql-signer` in particular are not something to bet a deploy on, and
// `pg` is not in the runtime at all. A few MB against a 50 MB limit is a cheap
// price for "what we tested is what runs". esbuild's ESM output needs the
// createRequire banner because parts of the SDK — and all of `pg` — are CJS.
//
// PURE-JS `pg`, NEVER `pg-native`. node-postgres reaches for two optional native
// escape hatches: `pg-native` (a libpq binding, behind a lazy getter) and
// `cloudflare:sockets` (a workerd builtin). Neither is installed and neither can
// be, so both are replaced with a stub that THROWS IF IT IS EVER EVALUATED. That
// is deliberate: marking them `external` would emit a top-level ESM import of a
// module that does not exist and break the bundle at load; silently returning an
// empty object would let a future `pg.native` call fail somewhere confusing. The
// stub is unreachable in practice — nothing here touches either path.
//
// THE ZIP IS BYTE-DETERMINISTIC (fixed 1980 timestamps, sorted entries), which is
// what makes Terraform's `source_code_hash` meaningful: rebuilding without
// changing a source file produces the same hash and therefore NO redeploy. A zip
// stamped with Date.now() would redeploy the function on every apply forever.
//
// Zero dependencies beyond esbuild: the zip writer below is ~60 lines of the
// format, which beats adding an archiver to a tree whose .npmrc exists precisely
// to keep the dependency count honest.
// =============================================================================

import { deflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const ENTRY = join(HERE, 'lambda', 'submit.ts')
const CONTRACT = join(ROOT, 'src', 'shared', 'feedback.ts')
const OUT_DIR = join(HERE, 'dist')
const OUT_JS = join(OUT_DIR, 'submit.mjs')
const OUT_ZIP = join(OUT_DIR, 'submit.zip')

const say = (line) => process.stdout.write(`${line}\n`)

// ---- minimal deterministic zip ---------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** DOS date/time for 1980-01-01 00:00 — the earliest the format can express. */
const DOS_TIME = 0
const DOS_DATE = 0x0021
/** version-made-by 3.0/unix + regular file 0644, so the extracted file is readable. */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0

function zipEntry(name, data) {
  const nameBuf = Buffer.from(name, 'utf8')
  const deflated = deflateRawSync(data, { level: 9 })
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  return { nameBuf, deflated, crc, size: data.length, local }
}

function zipCentral(entry, offset) {
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x031e, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(DOS_TIME, 12)
  central.writeUInt16LE(DOS_DATE, 14)
  central.writeUInt32LE(entry.crc, 16)
  central.writeUInt32LE(entry.deflated.length, 20)
  central.writeUInt32LE(entry.size, 24)
  central.writeUInt16LE(entry.nameBuf.length, 28)
  central.writeUInt32LE(EXTERNAL_ATTRS, 38)
  central.writeUInt32LE(offset, 42)
  return central
}

/** @param {{name: string, data: Buffer}[]} files */
function makeZip(files) {
  const parts = []
  const centrals = []
  let offset = 0
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const entry = zipEntry(file.name, file.data)
    centrals.push(Buffer.concat([zipCentral(entry, offset), entry.nameBuf]))
    parts.push(entry.local, entry.nameBuf, entry.deflated)
    offset += entry.local.length + entry.nameBuf.length + entry.deflated.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

// ---- build ------------------------------------------------------------------

/** Optional native/edge backends of `pg` that this Lambda neither has nor wants. */
const UNBUNDLABLE = /^(pg-native|cloudflare:sockets)$/

const stubNativeBackends = {
  name: 'stub-pg-native-backends',
  setup(build) {
    build.onResolve({ filter: UNBUNDLABLE }, (args) => ({
      path: args.path,
      namespace: 'pg-stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'pg-stub' }, (args) => ({
      // Evaluated only if something actually requires it, which nothing does.
      contents: `throw new Error(${JSON.stringify(
        `${args.path} is deliberately not bundled — this Lambda uses pure-JS pg`,
      )})`,
      loader: 'js',
    }))
  },
}

async function main() {
  try {
    statSync(CONTRACT)
  } catch {
    throw new Error(
      `the shared contract is missing: ${CONTRACT}\n` +
        'infra/lambda/submit.ts imports validateSubmit from it on purpose — one validator, ' +
        'client and server. Land src/shared/feedback.ts before building the handler.',
    )
  }

  let esbuild
  try {
    esbuild = await import('esbuild')
  } catch {
    throw new Error(
      'esbuild is not resolvable from this tree. It ships as a dependency of vite/tsx, ' +
        'but the Lambda bundle should not rely on that transitively — add `esbuild` to the ' +
        'root devDependencies.',
    )
  }

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_JS,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    plugins: [stubNativeBackends],
    // Parts of the AWS SDK are CJS and call `require` after bundling into ESM.
    banner: {
      js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
    legalComments: 'none',
    metafile: false,
    logLevel: 'warning',
  })
  if (result.errors.length > 0) throw new Error('esbuild reported errors')

  const js = readFileSync(OUT_JS)
  writeFileSync(OUT_ZIP, makeZip([{ name: 'submit.mjs', data: js }]))

  const kb = (n) => `${Math.round(n / 1024)} KB`
  say(`bundled ${ENTRY}`)
  say(`  dist/submit.mjs  ${kb(js.length)}`)
  say(`  dist/submit.zip  ${kb(statSync(OUT_ZIP).size)}  (deterministic)`)
}

await main()
