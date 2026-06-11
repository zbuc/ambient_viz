#!/usr/bin/env bash
# Codegen: orrery .proto -> ts-proto TypeScript -> committed CommonJS under
# server/src/gen/. Run after editing any .proto (requires `npm install` here
# and a protoc on PATH). The bridge consumes the committed .js directly — no
# build step at runtime, per the repo's no-build rule.
set -euo pipefail
cd "$(dirname "$0")"

TS_OUT=.gen-ts
JS_OUT=../server/src/gen
rm -rf "$TS_OUT" && mkdir -p "$TS_OUT"

protoc \
  --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out="$TS_OUT" \
  --ts_proto_opt=outputJsonMethods=true \
  --ts_proto_opt=outputServices=false \
  --ts_proto_opt=useOptionals=messages \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=forceLong=number \
  --proto_path=. \
  common.proto bus.proto manifest.proto router.proto plugin.proto

./node_modules/.bin/tsc \
  --module commonjs --target es2020 --declaration \
  --esModuleInterop --skipLibCheck \
  --outDir "$JS_OUT" \
  "$TS_OUT"/*.ts

echo "generated:"
ls -la "$JS_OUT"
