#!/bin/bash

set -e

# 1. Den Frontend-Build in GitHub Actions ausführen
echo ">>> building frontend in github"
cd examples/main
npm install
npm run build
cd ../..

# 2. Den Hugging Face Space klonen
echo ">>> clone hf space"
rm -rf _tmp_hf_space
git clone https://Thorge-AI:${HF_TOKEN}@huggingface.co/spaces/Thorge-AI/wllama-Nova.ai --depth 1 _tmp_hf_space

# 3. Die neu gebauten Dateien von GitHub nach HF kopieren
echo ">>> copying build artifacts"
# Wir kopieren den Inhalt des 'dist' Ordners (Ergebnis von npm run build) 
# direkt in das Hauptverzeichnis des HF Spaces
cp -r examples/main/dist/* _tmp_hf_space/

# 4. Hochladen zu Hugging Face
echo ">>> push to hf"
cd _tmp_hf_space

# Konfiguration (falls noch nicht global gesetzt)
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
cd ..
rm -rf _tmp_hf_space

echo ">>> done"
