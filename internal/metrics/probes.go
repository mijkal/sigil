package metrics

// These probe scripts are delivered over SSH via stdin (`sh -s`) and were
// validated live against Linux (a Linux host, a Docker host) and macOS (a macOS host) hosts.
// All byte values are normalised to absolute bytes so the client never has to
// know the source unit. Keep them POSIX-sh — no bashisms.
//
// IMPORTANT: every awk-formatted number uses `printf "%.0f"`, never `%d` or a
// bare `print` of a large product. Debian's default awk is **mawk**, whose
// `printf "%d"` clamps to INT_MAX (2147483647) and whose `print` renders large
// products in scientific notation ("1.46e+10") — both silently corrupt memory
// and disk byte counts. `%.0f` goes through a double (exact to 2^53) and prints
// the full integer, so it is correct on mawk, gawk, and BSD awk alike.

// staticProbe branches on `uname` so a single round-trip returns static host
// info for both Linux and macOS.
const staticProbe = `
OS=$(uname -s)
echo "OS=$(echo "$OS" | tr A-Z a-z)"
echo "KERNEL=$(uname -r)"
echo "ARCH=$(uname -m)"
if [ "$OS" = "Darwin" ]; then
  echo "OSPRETTY=macOS $(sw_vers -productVersion 2>/dev/null)"
  echo "CORES=$(sysctl -n hw.ncpu)"
  echo "CPU=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo Apple)"
  echo "MEMTOTAL=$(sysctl -n hw.memsize)"
  echo "DISKTOTAL=$(df -k / | awk 'NR==2{printf "%.0f", $2*1024}')"
  echo "HASPSI=0"
else
  echo "OSPRETTY=$( [ -r /etc/os-release ] && . /etc/os-release; echo "${PRETTY_NAME:-$(uname -sr)}" )"
  echo "CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
  echo "CPU=$(awk -F: '/model name/{print $2; exit}' /proc/cpuinfo | sed 's/^ *//')"
  echo "MEMTOTAL=$(awk '/MemTotal/{printf "%.0f", $2*1024}' /proc/meminfo)"
  echo "DISKTOTAL=$(df -P / | awk 'NR==2{printf "%.0f", $2*1024}')"
  echo "HASPSI=$([ -r /proc/pressure/cpu ] && echo 1 || echo 0)"
fi
`

const linuxDynamic = `
echo "T=$(date +%s)"
echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg)"
awk '/some/{split($2,a,"=");print "PSICPU="a[2]}' /proc/pressure/cpu 2>/dev/null
awk '/some/{split($2,a,"=");print "PSIMEM="a[2]}' /proc/pressure/memory 2>/dev/null
awk '/MemTotal/{mt=$2}/MemAvailable/{ma=$2}/SwapTotal/{st=$2}/SwapFree/{sf=$2}END{printf "MEM=%.0f %.0f\nSWAP=%.0f %.0f\n",mt*1024,(mt-ma)*1024,st*1024,(st-sf)*1024}' /proc/meminfo
echo "DISK=$(df -P / | awk 'NR==2{printf "%.0f %.0f", $2*1024, $3*1024}')"
echo "NET=$(awk -F'[: ]+' 'NR>2 && $2!="lo"{rx+=$3;tx+=$11}END{printf "%.0f %.0f", rx, tx}' /proc/net/dev)"
echo "PROCS:"
ps -eo pcpu,pmem,comm --sort=-pcpu 2>/dev/null | awk 'NR>1 && NR<=7{print $1, $2, $3}'
`

const darwinDynamic = `
echo "T=$(date +%s)"
echo "LOAD=$(sysctl -n vm.loadavg | awk '{print $2, $3, $4}')"
MT=$(sysctl -n hw.memsize); PS=$(sysctl -n hw.pagesize)
USED=$(vm_stat | awk '/Pages active/{a=$3}/Pages wired down/{w=$4}/occupied by compressor/{c=$5}END{gsub(/\./,"",a);gsub(/\./,"",w);gsub(/\./,"",c);print a+w+c}')
echo "MEM=$MT $((USED*PS))"
echo "SWAP=$(sysctl -n vm.swapusage | awk '{gsub(/M/,"");printf "%.0f %.0f", $3*1048576, $6*1048576}')"
echo "DISK=$(df -k / | awk 'NR==2{printf "%.0f %.0f", $2*1024, $3*1024}')"
echo "NET=$(netstat -ib | awk '$1=="en0"{printf "%.0f %.0f", $7, $10; exit}')"
echo "PROCS:"
ps -Aceo pcpu,pmem,comm -r | awk 'NR>1 && NR<=7{print $1, $2, $3}'
`
