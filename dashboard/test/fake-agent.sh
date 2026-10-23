#!/bin/bash
# Stand-in agent for tests: shows a numbered menu like a real agent. Like real menus it acts on a single digit;
# other input is read as a line. "crash" exits 3.
while true; do
  printf 'Pick one:\n❯ 1. Yes\n  2. No\n↑/↓ to navigate · enter to select\n'
  IFS= read -r -n1 k || exit 0
  if [[ $k =~ [1-9] ]]; then printf '\ngot %s\n' "$k"; continue; fi
  IFS= read -r rest; line="$k$rest"
  [ "$line" = crash ] && exit 3
  printf 'got %s\n' "$line"
done
