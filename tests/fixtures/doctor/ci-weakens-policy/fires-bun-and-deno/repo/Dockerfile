FROM oven/bun:1
RUN bun install --minimum-release-age=0 && bun add --trust left-pad
RUN deno install --minimum-dependency-age=0 --allow-scripts
