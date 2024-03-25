import * as cache from "@actions/cache";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { extractTar, listTar } from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import * as path from "path";
import { State } from "./state";
import {
  findObject,
  formatSize,
  getInputAsArray,
  getInputAsBoolean,
  isGhes,
  newMinio,
  setCacheHitOutput,
  saveMatchedKey,
} from "./utils";

process.on("uncaughtException", (e) => core.info("warning: " + e.message));

async function restoreCache() {
  try {
    const bucket = core.getInput("bucket", { required: true });
    const keyInput = core.getInput("key", { required: true });
    const useFallback = getInputAsBoolean("use-fallback");
    const useRepositoryPrefix = getInputAsBoolean("use-repository-prefix");
    const paths = getInputAsArray("path");
    const restoreKeysInput = getInputAsArray("restore-keys");
    const useExactKeyMatchInput = getInputAsBoolean("use-exact-key-match");

    let key = keyInput;
    let restoreKeys = restoreKeysInput;

    const repositoryName = process.env.GITHUB_REPOSITORY?.replace(
      `${process.env.GITHUB_REPOSITORY_OWNER || ""}/`,
      ""
    );
    if (useRepositoryPrefix && repositoryName) {
      key = `${repositoryName}-${keyInput}`;
      restoreKeys = restoreKeysInput.map(
        (restoreKey) => `${repositoryName}-${restoreKey}`
      );
    }

    if (useExactKeyMatchInput) {
      core.info("Restoring cache with exact key match");
      restoreKeys = [];
    }

    try {
      // Inputs are re-evaluted before the post action, so we want to store the original values
      core.saveState(State.PrimaryKey, key);
      core.saveState(State.AccessKey, core.getInput("accessKey"));
      core.saveState(State.SecretKey, core.getInput("secretKey"));
      core.saveState(State.SessionToken, core.getInput("sessionToken"));

      const mc = newMinio();

      const compressionMethod = await utils.getCompressionMethod();
      const cacheFileName = utils.getCacheFileName(compressionMethod);
      const archivePath = path.join(
        await utils.createTempDirectory(),
        cacheFileName
      );

      const { item: obj, matchingKey } = await findObject(
        mc,
        bucket,
        key,
        restoreKeys,
        compressionMethod
      );
      core.debug("found cache object");
      saveMatchedKey(matchingKey);
      core.info(
        `Downloading cache from s3 to ${archivePath}. bucket: ${bucket}, object: ${obj.name}`
      );

      if (!obj.name) {
        core.error("Cache not found");
        return;
      }

      mc.fGetObject(bucket, obj.name, archivePath);

      if (core.isDebug()) {
        await listTar(archivePath, compressionMethod);
      }

      core.info(`Cache Size: ${formatSize(obj.size)} (${obj.size} bytes)`);

      await extractTar(archivePath, compressionMethod);
      setCacheHitOutput(matchingKey === key);
      core.info("Cache restored from s3 successfully");
    } catch (e) {
      core.info("Restore s3 cache failed: " + (e as Error).message);
      setCacheHitOutput(false);
      if (useFallback) {
        if (isGhes()) {
          core.warning("Cache fallback is not supported on Github Enterpise.");
        } else {
          core.info("Restore cache using fallback cache");
          const fallbackMatchingKey = await cache.restoreCache(
            paths,
            key,
            restoreKeys
          );
          if (fallbackMatchingKey) {
            setCacheHitOutput(fallbackMatchingKey === key);
            core.info("Fallback cache restored successfully");
          } else {
            core.info("Fallback cache restore failed");
          }
        }
      }
    }
  } catch (e) {
    core.setFailed((e as Error).message);
  }
}

restoreCache();
