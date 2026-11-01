FROM python:3.12-slim AS app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.13.14-alpine3.24 AS tools
RUN python -m pip install --upgrade pip==26.2.2 \
 && pip install -r requirements.txt
