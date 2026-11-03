FROM ruby:3.4
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install --cooldown=5
