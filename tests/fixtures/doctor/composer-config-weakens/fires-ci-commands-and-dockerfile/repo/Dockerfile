FROM composer:2
ENV COMPOSER_POLICY=0
ARG COMPOSER_POLICY_COOLDOWN_PERIOD="1 day"
RUN composer install --no-blocking
