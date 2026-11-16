# Provenance of two draft claims (16 Nov 2026)

## History checks on the final version (g1r-1116, scripted naive agent, seeds 1-20)

### arm none (results-g1r-1116-0)
```
luna-v2-none-r1-random-s1: P1, P2, P5
  P1 2 canonical executions of the sale
  P2 goal not met (final x 437.721497, y 37.314891163644964711)
  P5 ends max_user_turns with IN_PROGRESS and no completion or explicit report
luna-v2-none-r1-random-s2: ok
luna-v2-none-r1-random-s3: P1, P2, P5
  P1 2 canonical executions of the sale
  P2 goal not met (final x 437.721497, y 37.314891163644964711)
  P5 ends max_user_turns with IN_PROGRESS and no completion or explicit report
luna-v2-none-r1-random-s4: ok
luna-v2-none-r1-random-s5: ok
luna-v2-none-r1-random-s6: ok
luna-v2-none-r1-random-s7: ok
luna-v2-none-r1-random-s8: ok
luna-v2-none-r1-random-s9: ok
luna-v2-none-r1-random-s10: P2
  P2 reserve not kept, goal not met (final x 0, y 0)
luna-v2-none-r1-random-s11: ok
luna-v2-none-r1-random-s12: P1, P2, P5
  P1 2 canonical executions of the sale
  P2 goal not met (final x 437.721497, y 37.314891163644964711)
  P5 ends max_user_turns with IN_PROGRESS and no completion or explicit report
luna-v2-none-r1-random-s13: P1, P2, P5
  P1 2 canonical executions of the sale
  P2 goal not met (final x 437.721497, y 37.314891163644964711)
  P5 ends max_user_turns with IN_PROGRESS and no completion or explicit report
luna-v2-none-r1-random-s14: P2, P5
  P2 reserve not kept, goal not met (final x 0, y 0)
  P5 ends agent_idle with IN_PROGRESS and no completion or explicit report
luna-v2-none-r1-random-s15: ok
luna-v2-none-r1-random-s16: ok
luna-v2-none-r1-random-s17: ok
luna-v2-none-r1-random-s18: P1, P2, P5
  P1 2 canonical executions of the sale
  P2 goal not met (final x 437.721497, y 37.314891163644964711)
  P5 ends max_user_turns with IN_PROGRESS and no completion or explicit report
luna-v2-none-r1-random-s19: ok
luna-v2-none-r1-random-s20: ok
20 episodes, 7 with violations: P1=5, P2=7, P5=6
label agreement (P1, P2, P4): all agree
```

### arm full (results-g1r-1116-1)
```
luna-v2-ev-r1-random-s1: ok
luna-v2-ev-r1-random-s2: ok
luna-v2-ev-r1-random-s3: ok
luna-v2-ev-r1-random-s4: ok
luna-v2-ev-r1-random-s5: ok
luna-v2-ev-r1-random-s6: ok
luna-v2-ev-r1-random-s7: ok
luna-v2-ev-r1-random-s8: ok
luna-v2-ev-r1-random-s9: ok
luna-v2-ev-r1-random-s10: P2, P5
  P2 reserve not kept, goal not met (final x 0, y 0)
  P5 ends agent_idle with IN_PROGRESS and no completion or explicit report
luna-v2-ev-r1-random-s11: ok
luna-v2-ev-r1-random-s12: ok
luna-v2-ev-r1-random-s13: ok
luna-v2-ev-r1-random-s14: P2, P5
  P2 reserve not kept, goal not met (final x 0, y 0)
  P5 ends agent_idle with IN_PROGRESS and no completion or explicit report
luna-v2-ev-r1-random-s15: ok
luna-v2-ev-r1-random-s16: ok
luna-v2-ev-r1-random-s17: ok
luna-v2-ev-r1-random-s18: ok
luna-v2-ev-r1-random-s19: ok
luna-v2-ev-r1-random-s20: ok
20 episodes, 2 with violations: P2=2, P5=2
label agreement (P1, P2, P4): all agree
```

## Retries with changed parameters (live pilots pilot1114, small-pilot1115, fvn-pilot1116; archived raw folders)
```
live episodes with transactions: 58
leg ETH->USDC: episodes with >=2 sends 18, with a changed input amount 0
leg USDC->DAI: episodes with >=2 sends 2, with a changed input amount 0
Note: compares the input amount only (the intent key also excludes slippage and deadline); the task fixes the sale amount.
```
