import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import * as minio from "minio";
import { State } from "./state";
import path from "path";
import { createTar, listTar } from "@actions/cache/lib/internal/tar";
import * as cache from "@actions/cache";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { writeFileSync } from "fs";

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env["GITHUB_SERVER_URL"] || "https://github.com"
  );
  return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function getInput(key: string, envKey?: string) {
  let result;
  if (envKey) {
    result = process.env[envKey]
  }
  if (result === undefined) {
    result = core.getInput(key);
  }
  return result;
}

export function newMinio({
  accessKey,
  secretKey,
  sessionToken,
  region,
}: {
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
  region?: string;
} = {}) {
  return new minio.Client({
    endPoint: core.getInput("endpoint"),
    port: getInputAsInt("port"),
    useSSL: !getInputAsBoolean("insecure"),
    accessKey: accessKey ?? getInput("accessKey", "AWS_ACCESS_KEY_ID"),
    secretKey: secretKey ?? getInput("secretKey", "AWS_SECRET_ACCESS_KEY"),
    sessionToken: sessionToken ?? getInput("sessionToken", "AWS_SESSION_TOKEN"),
    region: region ?? getInput("region", "AWS_REGION"),
  });
}

export function getInputAsBoolean(
  name: string,
  options?: core.InputOptions
): boolean {
  return core.getInput(name, options) === "true";
}

export function getInputAsArray(
  name: string,
  options?: core.InputOptions
): string[] {
  return core
    .getInput(name, options)
    .split("\n")
    .map((s) => s.trim())
    .filter((x) => x !== "");
}

export function getInputAsInt(
  name: string,
  options?: core.InputOptions
): number | undefined {
  const value = parseInt(core.getInput(name, options));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function formatSize(value?: number, format = "bi") {
  if (!value) return "";
  const [multiple, k, suffix] = (
    format === "bi" ? [1000, "k", "B"] : [1024, "K", "iB"]
  ) as [number, string, string];
  const exp = (Math.log(value) / Math.log(multiple)) | 0;
  const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
  return (
    size +
    (exp ? (k + "MGTPEZY")[exp - 1] + suffix : "byte" + (size !== 1 ? "s" : ""))
  );
}

export function setCacheHitOutput(isCacheHit: boolean): void {
  core.setOutput("cache-hit", isCacheHit.toString());
}

export function setCacheSizeOutput(cacheSize: number): void {
  core.setOutput("cache-size", cacheSize.toString())
}

type FindObjectResult = {
  item: minio.BucketItem;
  matchingKey: string;
};

export async function findObject(
  mc: minio.Client,
  bucket: string,
  key: string,
  restoreKeys: string[],
  compressionMethod: CompressionMethod
): Promise<FindObjectResult> {
  core.debug("Key: " + JSON.stringify(key));
  core.debug("Restore keys: " + JSON.stringify(restoreKeys));

  core.debug(`Finding exact match for: ${key}`);
  const exactMatch = await listObjects(mc, bucket, key);
  core.debug(`Found ${JSON.stringify(exactMatch, null, 2)}`);
  if (exactMatch.length) {
    const result = { item: exactMatch[0], matchingKey: key };
    core.debug(`Using ${JSON.stringify(result)}`);
    return result;
  }

  for (const restoreKey of restoreKeys) {
    const fn = utils.getCacheFileName(compressionMethod);
    core.debug(`Finding object with prefix: ${restoreKey}`);
    let objects = await listObjects(mc, bucket, restoreKey);
    objects = objects.filter((o) => o.name.includes(fn));
    core.debug(`Found ${JSON.stringify(objects, null, 2)}`);
    if (objects.length < 1) {
      continue;
    }
    const sorted = objects.sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
    );
    const result = { item: sorted[0], matchingKey: restoreKey };
    core.debug(`Using latest ${JSON.stringify(result)}`);
    return result;
  }
  throw new Error("Cache item not found");
}

export function listObjects(
  mc: minio.Client,
  bucket: string,
  prefix: string
): Promise<minio.BucketItem[]> {
  return new Promise((resolve, reject) => {
    const h = mc.listObjectsV2(bucket, prefix, true);
    const r: minio.BucketItem[] = [];
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved)
        reject(new Error("list objects no result after 10 seconds"));
    }, 10000);

    h.on("data", (obj) => {
      r.push(obj);
    });
    h.on("error", (e) => {
      resolved = true;
      reject(e);
      clearTimeout(timeout)
    });
    h.on("end", () => {
      resolved = true;
      resolve(r);
      clearTimeout(timeout)
    });
  });
}

export function saveMatchedKey(matchedKey: string) {
  return core.saveState(State.MatchedKey, matchedKey);
}

function getMatchedKey() {
  return core.getState(State.MatchedKey);
}

export function isExactKeyMatch(): boolean {
  const matchedKey = getMatchedKey();
  const inputKey = core.getState(State.PrimaryKey);
  const result = getMatchedKey() === inputKey;
  core.debug(
    `isExactKeyMatch: matchedKey=${matchedKey} inputKey=${inputKey}, result=${result}`
  );
  return result;
}

export async function saveCache(standalone: boolean) {
  try {
    const forceSave = getInputAsBoolean("force-save");

    if (forceSave) {
      core.info("Force save is enabled");
    }

    if (isExactKeyMatch() && !(forceSave || standalone)) {
      core.info("Cache was exact key match, not saving");
      return;
    }

    const readOnly = getInputAsBoolean("read-only");

    if (readOnly) {
      core.info("Cache is read-only, not saving");
      return;
    }

    const bucket = core.getInput("bucket", { required: true });
    // Inputs are re-evaluted before the post action, so we want the original key
    const key = standalone ? core.getInput("key", { required: true }) : core.getState(State.PrimaryKey);
    const useFallback = getInputAsBoolean("use-fallback");
    const paths = getInputAsArray("path");
    const useAwsCli = getInputAsBoolean("use-aws-cli");
    const useTarStreaming = getInputAsBoolean("use-tar-streaming");

    try {
      const minioConfig = {
        // Inputs are re-evaluted before the post action, so we want the original keys & tokens
        accessKey: standalone ? getInput("accessKey", "AWS_ACCESS_KEY_ID") : core.getState(State.AccessKey),
        secretKey: standalone ? getInput("secretKey", "AWS_SECRET_ACCESS_KEY") : core.getState(State.SecretKey),
        sessionToken: standalone ? getInput("sessionToken", "AWS_SESSION_TOKEN") : core.getState(State.SessionToken),
        region: standalone ? getInput("region", "AWS_REGION") : core.getState(State.Region),
      }
      const mc = newMinio(minioConfig);

      const compressionMethod = await utils.getCompressionMethod();
      const cachePaths = await utils.resolvePaths(paths);
      core.debug("Cache Paths:");
      core.debug(`${JSON.stringify(cachePaths)}`);

      const cacheFileName = utils.getCacheFileName(compressionMethod);

      const tarProc = await execTarCreate(cachePaths);

      const object = path.join(key, cacheFileName);

      if (useTarStreaming) {
        if (useAwsCli) {
          core.info("Using AWS CLI to upload cache");
          const awsProc = execAwsCli(
            ["s3", "cp", "-", `s3://${bucket}/${object}`],
            {
              AWS_ACCESS_KEY_ID: minioConfig.accessKey,
              AWS_SECRET_ACCESS_KEY: minioConfig.secretKey,
              AWS_SESSION_TOKEN: minioConfig.sessionToken,
              AWS_REGION: minioConfig.region
            }
          )
          tarProc.stdout.pipe(awsProc.stdin);
        } else {
          await mc.putObject(bucket, object, tarProc.stdout)
        }
        core.info(`Uploading tar to s3. Bucket: ${bucket}, Object: ${object}`);
        // await the tar subprocess
        await new Promise((resolve, reject) => {
          tarProc.on('close', resolve);
          tarProc.on('error', reject);
        });
      } else {
        const archiveFolder = await utils.createTempDirectory();
        const cacheFileName = utils.getCacheFileName(compressionMethod);
        const archivePath = path.join(archiveFolder, cacheFileName);

        core.debug(`Archive Path: ${archivePath}`);

        await createTar(archiveFolder, cachePaths, compressionMethod);
        if (core.isDebug()) {
          await listTar(archivePath, compressionMethod);
        }

        core.info(`Uploading tar to s3. Bucket: ${bucket}, Object: ${object}`);
        await mc.fPutObject(bucket, object, archivePath, {});
      }
      core.info("Cache saved to s3 successfully");
    } catch (e) {
      core.info("Save s3 cache failed: " + (e as Error).message);
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Saving cache using fallback");
          await cache.saveCache(paths, key);
          core.info("Save cache using fallback successfully");
        }
      } else {
        core.debug("skipped fallback cache");
      }
    }
  } catch (e) {
    core.info("warning: " + (e as Error).message);
  }
}

export function getWorkingDirectory(): string {
  return process.env['GITHUB_WORKSPACE'] || process.cwd();
}

// Executes tar that extracts a zstd-compressed tarball from stdin
export function execTarExtract(): ChildProcessWithoutNullStreams {
  const args = [
    "-xf",
    "-",
    "-P",
    "-C",
    getWorkingDirectory(),
    "--use-compress-program",
    "unzstd"]
  core.debug("Executing: tar " + args.join(" "));
  const tarProc = spawn("tar", args)
  tarProc.stdout.pipe(process.stdout);
  tarProc.stderr.pipe(process.stderr);
  return tarProc;
}

// Executes tar that outputs a zstd-compressed tarball to stdout
// param: paths contains the archived paths
export async function execTarCreate(paths: string[]): Promise<ChildProcessWithoutNullStreams> {
  // write cachePaths to manifest.txt (avoid path length issues)
  const tempDir = await utils.createTempDirectory();
  const manifestPath = path.join(tempDir, "manifest.txt");
  writeFileSync(manifestPath, paths.join("\n"));
  const args = [
    "-cf",
    "-",
    "--posix",
    "-P",
    "-C",
    getWorkingDirectory(),
    "--use-compress-program",
    "zstdmt",
    "--files-from",
    manifestPath,
  ]
  core.debug("Executing: tar " + args.join(" "));
  const tarProc = spawn("tar", args)
  tarProc.stderr.pipe(process.stderr);
  return tarProc;
}

export function execAwsCli(args: string[], env: { [key: string]: string } = {}): ChildProcessWithoutNullStreams {
  core.debug("Executing: aws " + args.join(" "));
  const awsProc = spawn("aws", args, {
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: env["AWS_ACCESS_KEY_ID"] || core.getState(State.AccessKey),
      AWS_SECRET_ACCESS_KEY: env["AWS_SECRET_ACCESS_KEY"] || core.getState(State.SecretKey),
      AWS_SESSION_TOKEN: env["AWS_SESSION_TOKEN"] || core.getState(State.SessionToken),
      AWS_REGION: env["AWS_REGION"] || core.getState(State.Region) || process.env.AWS_REGION
    }
  });
  awsProc.stderr.pipe(process.stderr);
  return awsProc;
}
