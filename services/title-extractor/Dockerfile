FROM python:3.12-slim-bookworm
LABEL org.uchiyomi.hi-sam-revision="69009434d4dba5541f228d8f5acb0754c333d417"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TORCH_FORCE_WEIGHTS_ONLY_LOAD=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=3
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      torch==2.8.0+cpu torchvision==0.23.0
COPY requirements.txt /service/requirements.txt
RUN pip install --no-cache-dir -r /service/requirements.txt
# build-worker.py supplies an archive from the exact verified Git commit; no runtime downloads.
COPY hi-sam.tar /tmp/hi-sam.tar
RUN mkdir -p /opt/hi-sam /models && tar -xf /tmp/hi-sam.tar -C /opt/hi-sam && rm /tmp/hi-sam.tar \
 && rm -rf /opt/hi-sam/pretrained_checkpoint && ln -s /models /opt/hi-sam/pretrained_checkpoint
COPY worker.py server.py sam_refinement.py stroke_completion.py LICENSE NOTICE /service/
WORKDIR /service
USER 10002:10002
ENV PORT=3081 HI_SAM_DIR=/opt/hi-sam INFERENCE_THREADS=3
EXPOSE 3081
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import os,urllib.request; r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3081/healthz',headers={'authorization':'Bearer '+os.environ['TITLE_EXTRACTOR_TOKEN']}),timeout=3); assert r.status==200"
CMD ["python", "/service/server.py"]
