# shellcheck shell=bash
#
# Minimal dotenv parser for the deploy scripts (Issue #26).
#
# Source this file, then call:
#
#   dotenv_get NAME [FILE]      # FILE defaults to $ENV_FILE
#
# It prints the value of NAME the way Next.js's env loader (dotenv +
# dotenv-expand, via @next/env) would see it, so a value that works under
# `npm run dev` gets uploaded unchanged:
#
#   - the last `NAME=` line wins; an optional `export ` prefix is allowed;
#   - CRLF line endings are tolerated (the trailing CR is dropped);
#   - unquoted values end at the first `#` (inline comment) and are trimmed;
#   - "double", 'single' and `backtick` quotes are stripped, and a `#` inside
#     quotes is part of the value; anything after the closing quote must be
#     whitespace or a `# comment`;
#   - inside double quotes, `\n` / `\r` become a newline / CR (as in dotenv);
#   - `$NAME`, `${NAME}` and `${NAME:-default}` are expanded, except in
#     single-quoted values. NAME is resolved from the same file first (applying
#     these same rules recursively), then from the process environment. `\$` is a
#     literal `$`. Reference cycles are an error.
#   - a variable with no `NAME=` line prints nothing (empty) and succeeds.
#
# Multi-line quoted values are not supported.
#
# On a parse error, an undefined reference or a cycle it prints a message to
# stderr naming the variable(s) involved -- never a value -- and returns 1.
#
# Portable to bash 3.2 (macOS): no associative arrays, no `${var,,}`, etc.

# Print the raw right-hand side of the last `NAME=` line in FILE (CR stripped,
# no other processing). Returns 1 if FILE has no such line.
_dotenv_raw() {
  awk -v name="$1" '
    { sub(/\r$/, "") }
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      sub(/^export[ \t]+/, "", line)
      if (substr(line, 1, length(name)) != name) next
      rest = substr(line, length(name) + 1)
      if (rest !~ /^[ \t]*=/) next
      sub(/^[ \t]*=/, "", rest)
      found = 1
      val = rest
    }
    END {
      if (!found) exit 1
      printf "%s", val
    }
  ' "$2"
}

# Split a raw right-hand side into its value and quote style.
# Sets _DOTENV_VAL and _DOTENV_QUOTE (one of: none, single, double, backtick).
# $1 = variable name (for error messages only), $2 = raw right-hand side.
_dotenv_unquote() {
  local name="$1" raw="$2" q rest i c
  # Trim leading whitespace.
  raw="${raw#"${raw%%[![:space:]]*}"}"
  q="${raw:0:1}"
  _DOTENV_QUOTE=none

  if [ "$q" = '"' ] || [ "$q" = "'" ] || [ "$q" = '`' ]; then
    # Find the closing quote; a backslash escapes the next character (so `\"`
    # does not close a double-quoted value), mirroring dotenv's regex.
    i=1
    while [ "$i" -lt "${#raw}" ]; do
      c="${raw:$i:1}"
      if [ "$c" = '\' ]; then
        i=$((i + 2))
        continue
      fi
      if [ "$c" = "$q" ]; then
        break
      fi
      i=$((i + 1))
    done
    if [ "$i" -lt "${#raw}" ]; then
      rest="${raw:$((i + 1))}"
      rest="${rest#"${rest%%[![:space:]]*}"}"
      if [ -n "$rest" ] && [ "${rest:0:1}" != "#" ]; then
        echo "dotenv: $name: unexpected text after the closing quote" >&2
        return 1
      fi
      _DOTENV_VAL="${raw:1:$((i - 1))}"
      case "$q" in
        '"')
          _DOTENV_QUOTE=double
          _DOTENV_VAL="${_DOTENV_VAL//\\n/$'\n'}"
          _DOTENV_VAL="${_DOTENV_VAL//\\r/$'\r'}"
          ;;
        "'") _DOTENV_QUOTE=single ;;
        *) _DOTENV_QUOTE=backtick ;;
      esac
      return 0
    fi
    # No closing quote: dotenv falls back to treating it as an unquoted value.
  fi

  # Unquoted: everything up to the first `#` is the value, trimmed.
  raw="${raw%%#*}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  _DOTENV_VAL="$raw"
}

# Expand `$NAME`, `${NAME}`, `${NAME:-default}` and `\$` in $3.
# $1 = FILE, $2 = resolution stack (space-separated, for cycle detection; its
# last entry is the variable being expanded), $3 = value. Prints the result.
_dotenv_expand() {
  local file="$1" stack="$2" s="$3" out="" ref def body sub owner
  owner="${stack##* }"
  while [ -n "$s" ]; do
    case "$s" in
      '\$'*)
        out="$out\$"
        s="${s:2}"
        ;;
      '${'*)
        body="${s:2}"
        case "$body" in
          *'}'*) ;;
          *)
            echo "dotenv: $owner: unterminated \${...} reference" >&2
            return 1
            ;;
        esac
        body="${body%%\}*}"
        s="${s:$((${#body} + 3))}"
        def=""
        ref="$body"
        local has_def=0
        case "$body" in
          *:-*)
            ref="${body%%:-*}"
            def="${body#*:-}"
            has_def=1
            ;;
        esac
        case "$ref" in
          '' | [0-9]* | *[!A-Za-z0-9_]*)
            echo "dotenv: $owner: invalid reference \${$ref}" >&2
            return 1
            ;;
        esac
        sub="$(_dotenv_lookup "$file" "$stack" "$ref" "$has_def" "$def")" || return 1
        out="$out$sub"
        ;;
      '$'[A-Za-z_]*)
        ref="${s:1}"
        ref="${ref%%[!A-Za-z0-9_]*}"
        s="${s:$((${#ref} + 1))}"
        sub="$(_dotenv_lookup "$file" "$stack" "$ref" 0 "")" || return 1
        out="$out$sub"
        ;;
      *)
        out="$out${s:0:1}"
        s="${s:1}"
        ;;
    esac
  done
  printf '%s' "$out"
}

# Resolve a referenced variable: from FILE if it has a line for it, else from
# the process environment, else the default (if given), else an error.
# $1 = FILE, $2 = stack, $3 = NAME, $4 = has-default (0/1), $5 = default.
_dotenv_lookup() {
  local file="$1" stack="$2" ref="$3" has_def="$4" def="$5" v
  case " $stack " in
    *" $ref "*)
      echo "dotenv: reference cycle: ${stack// / -> } -> $ref" >&2
      return 1
      ;;
  esac
  if _dotenv_raw "$ref" "$file" >/dev/null; then
    v="$(_dotenv_resolve "$file" "$stack" "$ref")" || return 1
  elif [ -n "${!ref+x}" ]; then
    v="${!ref}"
  elif [ "$has_def" = 1 ]; then
    v="$def"
  else
    echo "dotenv: ${stack##* }: references \$$ref, which is not defined in the env file or the environment" >&2
    return 1
  fi
  if [ -z "$v" ] && [ "$has_def" = 1 ]; then
    v="$def"
  fi
  printf '%s' "$v"
}

# Fully resolve NAME from FILE. $1 = FILE, $2 = stack of names already being
# resolved (may be empty), $3 = NAME.
_dotenv_resolve() {
  local file="$1" stack="$2" name="$3" raw
  if [ -n "$stack" ]; then stack="$stack $name"; else stack="$name"; fi
  raw="$(_dotenv_raw "$name" "$file")" || return 0
  _dotenv_unquote "$name" "$raw" || return 1
  if [ "$_DOTENV_QUOTE" = single ]; then
    printf '%s' "$_DOTENV_VAL"
  else
    _dotenv_expand "$file" "$stack" "$_DOTENV_VAL"
  fi
}

# Public entry point: dotenv_get NAME [FILE]
dotenv_get() {
  local name="$1" file="${2:-${ENV_FILE:-}}"
  case "$name" in
    '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "dotenv: invalid variable name" >&2
      return 2
      ;;
  esac
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo "dotenv: env file not found" >&2
    return 2
  fi
  _dotenv_resolve "$file" "" "$name"
}
