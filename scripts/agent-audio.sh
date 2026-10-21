#!/bin/sh
# THE BOX'S SOUND - MEMELLI IO INC - authorized by Mel Briggs. No hardware here, so PulseAudio makes the devices the headless Chrome
# opens: "agent_speaker" (the default output - her voice, FreeCut's audio) and "agent_mic" (the default input - the monitor of
# "agent_mic_feed", which /mic/say plays a spoken line into). Tolerant like the rest of the image: a failure is logged, never fatal.
command -v pulseaudio >/dev/null 2>&1 || { echo "AGENT SOUND: pulseaudio is not installed"; exit 0; }
mkdir -p "${PULSE_RUNTIME_PATH:-/tmp/pulse-agent}"
pulseaudio --check 2>/dev/null || pulseaudio -D --exit-idle-time=-1 --disallow-exit --log-target=stderr || echo "AGENT SOUND: pulseaudio did not start"
i=0; while [ $i -lt 20 ] && ! pactl info >/dev/null 2>&1; do i=$((i + 1)); sleep 0.25; done
pactl load-module module-null-sink sink_name=agent_speaker sink_properties=device.description=Agent_Speaker >/dev/null 2>&1
pactl load-module module-null-sink sink_name=agent_mic_feed sink_properties=device.description=Agent_Mic_Feed >/dev/null 2>&1
pactl load-module module-virtual-source source_name=agent_mic master=agent_mic_feed.monitor source_properties=device.description=Agent_Mic >/dev/null 2>&1
pactl set-default-sink agent_speaker >/dev/null 2>&1
pactl set-default-source agent_mic >/dev/null 2>&1
echo "AGENT SOUND: mic $(pactl get-default-source 2>/dev/null || echo none) · speaker $(pactl get-default-sink 2>/dev/null || echo none)"
