FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    git curl ca-certificates \
    --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip3 install --break-system-packages \
    "justetf-scraping @ git+https://github.com/druzsan/justetf-scraping.git" \
    pandas pyyaml olefile playwright yfinance \
    beautifulsoup4 pypdf

RUN playwright install --with-deps chromium

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY public/ ./public/

RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "src/server.js"]
