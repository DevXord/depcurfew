FROM ruby:3.4
ENV BUNDLE_COOLDOWN=0
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install
