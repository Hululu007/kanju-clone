#!/bin/bash
n=$1; id=$2
out="outputs/acceptance-100/lines/$n.json"
[ -s "$out" ] && exit 0
curl -s -m 30 --proxy http://127.0.0.1:8202 "https://kanju-api.kenzhao123.workers.dev/api/lines?show=$id&ep=0" -o "$out"
