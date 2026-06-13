#!/bin/bash
git clone --depth 1 --branch master --no-checkout https://github.com/your-org/motif-vs-code-snippets-extension.git
if [ -d "motif-vs-code-snippets-extension" ];
then
    cd motif-vs-code-snippets-extension || exit
    git sparse-checkout set .
    git checkout master
    cd ..
    cp motif-vs-code-snippets-extension/motif-vscode-snippets*.vsix ./motif-vscode-snippets.vsix
    rm motif-vs-code-snippets-extension -rf
else
    echo "directory does not exist."
fi