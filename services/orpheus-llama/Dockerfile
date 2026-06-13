# Orpheus expressive-TTS token generator — llama.cpp (CUDA) serving a Q4_K_M
# GGUF. Benchmarked at ~85 tok/s on the GB10, which clears the ~83 tok/s
# realtime bar for 24 kHz SNAC audio — the only runtime/precision that does.
# Driven ONLY by the brain's reply text; it authors no content.
#
# The binaries are built on the host (CUDA 13.0, GB10/sm_121) and copied in.
# vllm-node provides a compatible CUDA 13.2 runtime (libcudart/libcublas .so.13)
# and the nvidia container runtime injects the driver.
FROM vllm-node:latest

COPY llama-bin/ /opt/llama/
RUN chmod +x /opt/llama/llama-server

ENV LD_LIBRARY_PATH=/opt/llama:/usr/local/cuda/lib64:/usr/local/cuda/targets/sbsa-linux/lib \
    ORB2_ORPHEUS_GGUF=/models/orpheus-q4_k_m.gguf
EXPOSE 8081
# -ngl 99: all layers on GPU. -c 2048: ample for one utterance. --parallel 1:
# single user. --cont-batching keeps streaming snappy.
CMD ["sh", "-c", "/opt/llama/llama-server -m \"$ORB2_ORPHEUS_GGUF\" -ngl 99 --host 0.0.0.0 --port 8081 -c 2048 --parallel 1 --cont-batching"]
