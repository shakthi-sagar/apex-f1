# f1sim generator — runs as a Cloudflare Container (linux/amd64)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    F1SIM_CACHE=/tmp/f1sim PORT=8080
WORKDIR /app

COPY pyproject.toml ./
RUN pip install --upgrade pip && \
    pip install "fastf1>=3.8" numpy scipy pandas requests "shapely>=2" boto3 pillow mapbox-earcut

COPY f1sim ./f1sim
EXPOSE 8080
CMD ["python", "-m", "f1sim.server"]
