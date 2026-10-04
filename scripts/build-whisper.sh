#!/usr/bin/env bash
# Builds whisper.cpp's command line tool for this system into resources/whisper,
# where the app finds it (packaged with the installers by electron-builder).
#
# - Windows and Linux: GPU through Vulkan (any vendor). Backends are loaded at
#   run time, so a system without Vulkan drivers falls back to the CPU, with
#   the best CPU variant for the processor.
# - macOS: GPU through Metal, one universal binary for Apple Silicon and Intel.
#
# Needs CMake and a C++ compiler; Windows and Linux also the Vulkan SDK
# (glslc and headers). CI runs this; locally `npm run whisper` downloads the
# CI build instead.
set -euo pipefail

VERSION=v1.9.4
root=$(cd "$(dirname "$0")/.." && pwd)
work="$root/.whisper-build"
out="$root/resources/whisper"

rm -rf "$work"
git clone --quiet --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp.git "$work/src"

common=(
  -DCMAKE_BUILD_TYPE=Release
  -DGGML_NATIVE=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DWHISPER_SDL2=OFF
  -DWHISPER_CURL=OFF
)

case "$(uname -s)" in
  Darwin)
    cmake -S "$work/src" -B "$work/build" "${common[@]}" \
      -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
      -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
    ;;
  Linux)
    cmake -S "$work/src" -B "$work/build" "${common[@]}" \
      -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DGGML_VULKAN=ON \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN'
    ;;
  *)
    # The newest Visual Studio installed (CMake's default generator), 64-bit.
    cmake -S "$work/src" -B "$work/build" "${common[@]}" \
      -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DGGML_VULKAN=ON \
      -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
    ;;
esac

cmake --build "$work/build" --config Release --target whisper-cli -j 4

rm -rf "$out"
mkdir -p "$out"
bin="$work/build/bin"
[ -d "$bin/Release" ] && bin="$bin/Release"
case "$(uname -s)" in
  Darwin) cp "$bin/whisper-cli" "$out/" ;;
  Linux)
    cp "$bin/whisper-cli" "$out/"
    find "$work/build" -name '*.so*' -exec cp -P {} "$out/" \;
    ;;
  *) cp "$bin"/whisper-cli.exe "$bin"/*.dll "$out/" ;;
esac
cp "$work/src/LICENSE" "$out/LICENSE-whisper.cpp.txt"
echo "$VERSION" > "$out/VERSION"
rm -rf "$work"
ls -la "$out"
