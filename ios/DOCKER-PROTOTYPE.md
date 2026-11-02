# Serve the prototype UI from Docker

This is a temporary deployment procedure for the physical-device proof. Use it after identifying the existing container, Compose files/project, image revision, and web root. The native app still downloads the UI from the server selected on the phone.

## Choose how to deliver the build

For this first proof, transfer the prepared static export and use the temporary mount below. This needs file/Compose access to the host, but no image registry.

For repeatable image releases, the recommended next step is GitHub Container Registry (GHCR) under the maintainer's account, with distinct test tags and a recorded image digest. The upstream project already builds its images for GHCR. A server or Docker dashboard can pull an image once its registry access is configured; a separate deployment connection is still needed to update the running service. Private GHCR pulls need authentication; public images can be pulled anonymously ([GitHub documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)). Image visibility and publication remain a separate decision.

Other workable delivery methods:

| Method | Appropriate use |
| --- | --- |
| Build on the remote host | Occasional testing when SSH and build resources are available |
| Transfer an image archive | Occasional deployments without a registry: build for the server's CPU architecture, then use `docker image save` and `docker image load` ([Docker documentation](https://docs.docker.com/reference/cli/docker/image/load/)) |
| Registry on the same server | Useful if the owner wants registry infrastructure for several projects; requires persistent storage, TLS, authentication, and ongoing operation ([Distribution documentation](https://distribution.github.io/distribution/about/deploying/)) |

A self-hosted registry can run alongside Uchiyomi, preferably behind the existing HTTPS proxy with authenticated access. It does not itself supply SSH access, edit Compose, or restart the app. No registry or published test image has been created yet.

## Identify the running deployment

These read-only commands show the image and Compose location without printing container environment variables or the expanded Compose configuration:

```sh
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
UCHI_CONTAINER='your-existing-container'
docker inspect --format 'image={{.Config.Image}} imageID={{.Image}} composeService={{index .Config.Labels "com.docker.compose.service"}} composeDirectory={{index .Config.Labels "com.docker.compose.project.working_dir"}} composeFiles={{index .Config.Labels "com.docker.compose.project.config_files"}}' "$UCHI_CONTAINER"
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination "readWrite=" .RW}}{{end}}' "$UCHI_CONTAINER"
```

For the all-in-one Node container, also check its package version and configured static root:

```sh
docker exec "$UCHI_CONTAINER" node -p 'JSON.stringify({version:require("/app/package.json").version,webRoot:process.env.WEB_ROOT})'
```

The current prototype export was built from upstream revision `e6047fc7`, version `0.103.1`, with the native-host patches in this worktree. Compare the running backend with that revision before mounting the export. An unrelated backend version needs a compatibility check or a prototype built against that version. With split containers, inspect the BFF version separately from the nginx web container.

## Prepare an immutable export directory

The local artifact is `ios/build/uchiyomi-web-prototype-e6047fc7.tar.gz`. Transfer it to the chosen host, verify its SHA-256, and extract into a new, versioned directory readable by the existing container user. The archive contains the contents of `web/out`, with `mobile-assets.json` at its root.

```sh
sha256sum uchiyomi-web-prototype-e6047fc7.tar.gz
# Expected: fe6d9351a0189aa89c156ab7bd6f4b95e60570e81fc24fde562bb9fb8b97c754
mkdir -p /absolute/deployment/path/ios-web-e6047fc7
tar -xzf uchiyomi-web-prototype-e6047fc7.tar.gz -C /absolute/deployment/path/ios-web-e6047fc7
```

Choose actual paths before running these commands. Retain the archive and the original Compose configuration for rollback. Serve the complete export as one directory; the inventory and its hashed assets must come from the same build.

## Apply a temporary Compose override

For the repository's standard all-in-one image, the web root is `/app/web`. Save a separate override file, substituting the actual service and host path:

```yaml
services:
  YOUR_EXISTING_SERVICE:
    volumes:
      - type: bind
        source: /absolute/deployment/path/ios-web-e6047fc7
        target: /app/web
        read_only: true
        bind:
          create_host_path: false
```

For the split nginx image, apply this to the web service with target `/usr/share/nginx/html`. For a custom `WEB_ROOT`, use its verified path. If the same target already has a mount, preserve that original mapping in the existing configuration.

Use the existing Compose project name, project directory, profiles, environment file, and complete ordered list of configuration files. Append the prototype override last. A standard single-file deployment would use:

```sh
docker compose -f compose.yml -f ios-web.override.yml config --quiet
docker compose -f compose.yml -f ios-web.override.yml up -d --no-deps --pull never --no-build YOUR_EXISTING_SERVICE
```

The second command recreates that service and briefly interrupts it; in an all-in-one installation that includes the API. Confirm the actual command and affected service before applying it to a live deployment. Preserve its current image and all database/library mounts. With a non-Compose deployment, adapt the existing container definition rather than improvising a replacement `docker run` command.

## Verify and roll back

Check the actual public HTTPS origin:

```sh
curl --fail --silent --show-error --dump-header /tmp/uchiyomi-manifest.headers \
  https://YOUR_SERVER/mobile-assets.json -o /tmp/uchiyomi-manifest.json
```

Require HTTP 200 with an `application/json` content type, protocol version 1, and all listed files available with the recorded sizes and SHA-256 hashes. HTTP 200 with HTML means the old frontend/fallback is still serving. Confirm normal browser sign-in and reading before preparing the phone's UI. Then follow the phone acceptance run in [README.md](README.md#required-phone-acceptance-run).

To roll back, rerun `up` with the **original complete file list**, omitting only the prototype override, and recreate the affected service:

```sh
docker compose -f compose.yml up -d --no-deps --pull never --no-build --force-recreate YOUR_EXISTING_SERVICE
```

Verify normal browser access afterward. The prototype native client retains its already-prepared UI locally; rolling the server back does not update or remove that cached generation. Automatic client UI updates and rollback are later implementation tasks.
