FROM python:3.13-alpine
WORKDIR /app
COPY photos.py ./
COPY web/catalog.json ./web/catalog.json
RUN python photos.py
COPY food_catalog.py ./
RUN python food_catalog.py
COPY server.py measurements.py ./
COPY web ./web
CMD ["python","server.py"]
