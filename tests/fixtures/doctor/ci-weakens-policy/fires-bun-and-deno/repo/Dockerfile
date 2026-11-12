FROM oven/bun:1
RUN bun install --minimum-release-age=0 && bun add --trust left-pad
RUN deno install --minimum-dependency-age=0 --allow-scripts
RUN bun install --minimum-release-age-excludes left-pad,typescript
RUN bun add --minimum-release-age-excludes=left-pad left-pad
