#!/bin/sh
# llama-server for the translation engine pack (.github/workflows/translate-pack.yml, pack.mjs), built the way the app
# image runs: Alpine 3.24 (musl), CPU only, every CPU variant of the architecture built and the best one loaded at run
# time (GGML_BACKEND_DL), no OpenMP (the image has no libgomp), no curl or SSL (the model comes from Uchiyomi's own
# download). Run it in an alpine:3.24 container:
#
#   docker run --rm -v "$PWD:/w" -w /w alpine:3.24 sh scripts/translate-pack/build-llama.sh /w/llama-out
#
# The source is llama.cpp at a pinned commit, fetched with git: the commit hash is the integrity check.
set -eux
OUT=${1:?usage: build-llama.sh <out dir>}
LLAMA_TAG=b11723
LLAMA_COMMIT=31288c9c66e59377f7788d920678a565bb89dd37

apk add --no-cache build-base cmake linux-headers git
SRC=$(mktemp -d)
cd "$SRC"
git init -q
git remote add origin https://github.com/ggml-org/llama.cpp.git
git fetch -q --depth 1 origin "$LLAMA_COMMIT"
git checkout -q FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$LLAMA_COMMIT" ]

cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
  -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DBUILD_SHARED_LIBS=ON \
  -DCMAKE_INSTALL_RPATH='$ORIGIN' -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
cmake --build build --target llama-server -j "$(nproc)"

mkdir -p "$OUT"
# The libraries with their version symlinks kept (-a), not copied three times over.
cp -a build/bin/llama-server build/bin/*.so* "$OUT"/
cp LICENSE "$OUT"/LICENSE-llama.cpp
echo "llama.cpp $LLAMA_TAG ($LLAMA_COMMIT), Alpine $(cat /etc/alpine-release), $(uname -m)" > "$OUT"/BUILD
ls -la "$OUT"
du -sh "$OUT"
