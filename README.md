# productboard/actions-cache

This is Productboard's maintained fork of
[tespkg/actions-cache](https://github.com/tespkg/actions-cache). The action
enables caching dependencies to S3-compatible storage, e.g. MinIO or AWS S3.

It also has a GitHub [@actions/cache](https://github.com/actions/toolkit/tree/main/packages/cache)
(v4) fallback if S3 save and restore fails.

Productboard workflows should use the `pb` branch:

```yaml
- uses: productboard/actions-cache@pb
```

## Productboard fork maintenance

### Branch model

- `main` mirrors `upstream/main` from `tespkg/actions-cache`.
- `pb` is Productboard's maintained branch and the default branch of this
  repository.
- Productboard changes live on `pb` as a small patch stack rebased on top of
  `main`.
- Normal pull requests must target `pb`, not `main`.
- Do not merge upstream into `pb`. Rebase `pb` on top of `main` when upstream is
  updated.
- This fork does not run any GitHub Actions workflows. The upstream workflows
  under `.github/workflows/` have been removed on `pb` because they were not
  reliably triggered for this fork and produced no useful signal. Run tests and
  the build locally instead (see below).

### Contributing

Start every Productboard change from `pb`:

```bash
git fetch --all --prune
git switch -c <your-branch> origin/pb
```

Make the change, then run the checks and rebuild generated action artifacts:

```bash
yarn install --pure-lockfile
yarn test
yarn build
```

Commit source changes, tests, and generated files under `dist/` when they
change. Open the pull request against `pb`.

This fork does not use Productboard-specific tags. Do not create or move tags
for testing a Productboard change. To test a change before it is merged, point
the consuming workflow at your branch:

```yaml
- uses: productboard/actions-cache@<your-branch>
```

For sub-actions, use the same branch ref:

```yaml
- uses: productboard/actions-cache/restore@<your-branch>
- uses: productboard/actions-cache/save@<your-branch>
```

After the pull request is merged, consuming workflows should go back to
`productboard/actions-cache@pb`.

### Updating from upstream

Updating from upstream is a maintainer task. First, make `main` mirror the
current upstream state:

```bash
git fetch --all --prune

backup_branch=main-before-upstream-sync-$(date +%Y%m%d-%H%M%S)
git branch "$backup_branch" origin/main
git push origin "$backup_branch"

git switch -C main upstream/main
git push --force-with-lease origin main
```

Then rebase Productboard changes on top of the updated `main`:

```bash
git switch -C pb origin/pb
git rebase origin/main

yarn install --pure-lockfile
yarn test
yarn build

git push --force-with-lease origin pb
```

If upstream has accepted a Productboard-specific fix, drop the duplicate commit
during the rebase instead of keeping the same change twice. If conflicts touch
`dist/`, resolve the source files first, run `yarn build`, and commit the
generated output.

## Usage

```yaml
name: dev ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build_test:
    runs-on: [ubuntu-latest]

    steps:
      - uses: productboard/actions-cache@pb
        with:
          endpoint: play.min.io # optional, default s3.amazonaws.com
          insecure: false # optional, use http instead of https. default false
          accessKey: "Q3AM3UQ867SPQQA43P2F" # required
          secretKey: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG" # required
          sessionToken: "AQoDYXdzEJraDcqRtz123" # optional
          bucket: actions-cache # required
          use-fallback: true # optional, use github actions cache fallback, default true
          retry: true # optional, enable retry on failure s3 operations, default false
          force-save: true # optional, force save cache even the key was an exact match, will not save if the cache is read only, default false

          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
            .cache
          restore-keys: |
            ${{ runner.os }}-yarn-
```

You can also set env instead of using `with`:

```yaml
      - uses: productboard/actions-cache@pb
        env:
          AWS_ACCESS_KEY_ID: "Q3AM3UQ867SPQQA43P2F"
          AWS_SECRET_ACCESS_KEY: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG"
          # AWS_SESSION_TOKEN: "xxx"
          AWS_REGION: "us-east-1"
        with:
          endpoint: play.min.io
          bucket: actions-cache
          use-fallback: false
          key: test-${{ runner.os }}-${{ github.run_id }}
          path: |
            test-cache
            ~/test-cache
```

To write to the cache only:

```yaml
      - uses: productboard/actions-cache/save@pb
        with:
          accessKey: "Q3AM3UQ867SPQQA43P2F" # required
          secretKey: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG" # required
          bucket: actions-cache # required
          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

To restore from the cache only:

```yaml
      - uses: productboard/actions-cache/restore@pb
        with:
          accessKey: "Q3AM3UQ867SPQQA43P2F" # required
          secretKey: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG" # required
          bucket: actions-cache # required
          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

To check if cache hits and size is not zero without downloading:

```yaml
      - name: Check cache
        id: cache
        uses: productboard/actions-cache@pb
        with:
          accessKey: "Q3AM3UQ867SPQQA43P2F" # required
          secretKey: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG" # required
          bucket: actions-cache # required
          lookup-only: true
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules

      - name: verify cache hit
        env:
          CACHE_HIT: ${{ steps.cache.outputs.cache-hit }}
          CACHE_SIZE: ${{ steps.cache.outputs.cache-size }}
        run: |
          echo "CACHE_HIT $CACHE_HIT"
          echo "CACHE_SIZE $CACHE_SIZE"
```


## Outputs

| Output | Description |
|---|---|
| `cache-hit` | A boolean value (`true`/`false`). `true` when an exact match is found for the primary `key`. |
| `cache-size` | Size of the cache object found, measured in bytes. |
| `cache-matched-key` | The key of the cache entry that was restored. On exact match this equals the input `key`. On a `restore-keys` prefix match this is the matched restore key. Empty string if no cache was found. |

## Restore keys

`restore-keys` works similar to how github's `@actions/cache` (v4) works: It search each item in `restore-keys`
as prefix in object names and use the latest one

To restore from the cache using a `restore-key` prefix if the `key` restore fails:

```yaml
      - uses: productboard/actions-cache/restore@pb
        with:
          accessKey: "Q3AM3UQ867SPQQA43P2F" # required
          secretKey: "zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG" # required
          bucket: actions-cache # required
          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          restore-keys: |
            ${{ runner.os }}-yarn-
            ${{ runner.os }}-
          path: |
            node_modules
```

If a match is found using one of the `restore-keys` options, then `cache-hit` will be FALSE but the
`cache-matched-key` output will be set to the key that matched. See the
[actions/cache](https://github.com/actions/cache/blob/main/restore/README.md#outputs) notes.

## Amazon S3 permissions

When using this with Amazon S3, the following permissions are necessary:

 - `s3:PutObject`
 - `s3:GetObject`
 - `s3:ListBucket`
 - `s3:GetBucketLocation`
 - `s3:ListBucketMultipartUploads`
 - `s3:ListMultipartUploadParts`
