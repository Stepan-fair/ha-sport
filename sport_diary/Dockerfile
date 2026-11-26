FROM python:3.13-alpine
WORKDIR /app
RUN apk add --no-cache nodejs tzdata
COPY photos.py ./
COPY web/catalog.json ./web/catalog.json
RUN python photos.py
COPY food_catalog.py ./
COPY web/food-words.json ./web/food-words.json
RUN python food_catalog.py
COPY server.py measurements.py nutrition.py ./
COPY web ./web
CMD ["python","server.py"]
