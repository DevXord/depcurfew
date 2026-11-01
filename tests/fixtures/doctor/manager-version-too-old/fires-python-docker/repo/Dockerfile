FROM python:3.12-slim AS app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.13-slim AS worker
RUN pip install -r requirements.txt

FROM python:3.13.14-slim AS current
RUN pip install -r requirements.txt
