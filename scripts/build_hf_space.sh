#!/bin/bash

set -e

# 1. Sicherstellen, dass wir im Hauptverzeichnis des Repos starten
# (Das Skript liegt in /scripts, also gehen wir eine Ebene hoch)
cd "$(dirname "$0")/.."
ROOT_DIR=$(pwd)

echo ">>> Aktuelles Verzeichnis: $ROOT_DIR"

# 2. Den Frontend-Build in GitHub Actions ausführen
echo ">>> building frontend in github"
if [ -d "examples/main" ]; then
  cd examples/main
  npm install
  npm run build
  cd "$ROOT_DIR"
else
  echo "FEHLER: Verzeichnis examples/main nicht gefunden!"
  exit 1
fi

# 3. Den Hugging Face Space klonen
echo ">>> clone hf space"
rm -rf _tmp_hf_space
git clone https://Thorge-AI:${HF_TOKEN}@huggingface.co/spaces/Thorge-AI/wllama-Nova.ai --depth 1 _tmp_hf_space

# 4. Die neu gebauten Dateien kopieren
echo ">>> copying build artifacts"
# Prüfen, ob der Build-Ordner existiert (Vite nutzt meist 'dist')
if [ -d "examples/main/dist" ]; then
  cp -r examples/main/dist/* _tmp_hf_space/
else
  echo "FEHLER: Build-Ausgabe (dist) nicht gefunden!"
  exit 1
fi

# 5. Hochladen zu Hugging Face
echo ">>> push to hf"
cd _tmp_hf_space

git config user.email "bot@thorge-ai.com"
git config user.name "Thorge-AI Bot"

if [ -z "$(git status --porcelain)" ]; then
  echo "nothing changed, skipping..."
  exit 0
fi

git add -A
git commit -m "update: native wikipedia and memory management"
git push

echo ">>> clean up"
cd "$ROOT_DIR"
rm -rf _tmp_hf_space

echo ">>> done"
