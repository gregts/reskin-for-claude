umask 077
d="$1"; max="$2"; emax="$3"; f="$d/skin.log"; lock="$d/.skin.log.lock"; tmp=""
cleanup() { [ -n "$tmp" ] && /bin/rm -f "$tmp"; }
trap cleanup EXIT
trap 'exit 9' INT TERM HUP
[ -L "$d" ] && exit 3
/bin/mkdir -p "$d" || exit 3
[ -d "$d" ] && [ -O "$d" ] || exit 3
/bin/chmod 700 "$d" 2>/dev/null
[ -L "$lock" ] && exit 3
exec 9>>"$lock" || exit 3
/usr/bin/lockf -s -t 3 9 || exit 4
/usr/bin/find "$d" -maxdepth 1 -name '.entry.*' -type f -mmin +1 -delete 2>/dev/null
tmp=$(/usr/bin/mktemp "$d/.entry.XXXXXX") || exit 3
/usr/bin/head -c $((emax + 1)) > "$tmp"
add=$(/usr/bin/stat -f %z "$tmp")
[ "$add" -gt "$emax" ] && exit 8
mine() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] && [ "$(/usr/bin/stat -f %l "$1")" = 1 ]; }
if [ -e "$f" ] || [ -L "$f" ]; then mine "$f" || exit 5; fi
size=0; [ -f "$f" ] && size=$(/usr/bin/stat -f %z "$f")
sep=0; [ "$size" -gt 0 ] && [ -n "$(/usr/bin/tail -c 1 "$f")" ] && sep=1
if [ $((size + sep + add)) -gt "$max" ] && [ "$size" -gt 0 ]; then
  if [ -e "$f.1" ] || [ -L "$f.1" ]; then mine "$f.1" || exit 6; fi
  /bin/mv -f "$f" "$f.1" || exit 6
  sep=0
fi
[ "$sep" = 1 ] && { printf '\n' >> "$f" || exit 7; }
/bin/cat "$tmp" >> "$f" && /bin/chmod 600 "$f" || exit 7
exit 0
