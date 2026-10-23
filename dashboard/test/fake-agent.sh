#!/bin/bash
# Stand-in agent for tests: shows a numbered menu like a real agent, echoes each answer, exits 3 on "crash".
while true; do
  printf 'Pick one:\n❯ 1. Yes\n  2. No\n↑/↓ to navigate · enter to select\n'
  read -r line || exit 0
  [ "$line" = crash ] && exit 3
  printf 'got %s\n' "$line"
done
