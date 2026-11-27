FROM python:3.13-alpine
WORKDIR /app
RUN apk add --no-cache nodejs tzdata
COPY photos.py ./
COPY web/catalog.json ./web/catalog.json
RUN python photos.py
COPY food_catalog.py ./
COPY web/food-words.json ./web/food-words.json
RUN python food_catalog.py
COPY server.py measurements.py nutrition.py health_sensors.py ./
COPY web/index.html web/assistant.html web/style.css web/health.css \
     web/app.js web/assistant.js web/logic.js web/visibility.js web/foods.js web/portions.js \
     web/nutrition-summary.js web/report-view.js web/reports.js \
     web/goals.js web/goals-view.js web/health.js web/health-view.js ./web/
CMD ["python","server.py"]
