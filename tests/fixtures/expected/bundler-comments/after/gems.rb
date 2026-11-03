=begin
source "https://rubygems.org"
These lines are a comment: Bundler does not read them.
=end
# source "https://rubygems.org", cooldown: 30

NOTE = <<~TEXT
  source "https://rubygems.org"
TEXT

source "https://rubygems.org", :cooldown => 3   # a value depcurfew apply updates

gem "rack", "~> 3.2"
