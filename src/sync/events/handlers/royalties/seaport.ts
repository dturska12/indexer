import { getEnhancedEventFromTransaction } from "../";

import { bn } from "@/common/utils";
import * as utils from "@/events-sync/utils";
import { parseCallTrace } from "@georgeroman/evm-tx-simulator";
import { Royalty, getDefaultRoyalties } from "@/utils/royalties";
import { formatEther } from "@ethersproject/units";

import { parseEnhancedEventsToEventsInfo } from "@/events-sync/index";
import { parseEventsInfo } from "@/events-sync/handlers";
import { EnhancedEvent, OnChainData } from "@/events-sync/handlers/utils";
import { concat } from "@/common/utils";
import * as es from "@/events-sync/storage";

export async function parseEnhancedEventToOnChainData(enhancedEvents: EnhancedEvent[]) {
  const eventsInfos = await parseEnhancedEventsToEventsInfo(enhancedEvents, false);
  const allOnChainData: OnChainData[] = [];
  for (let index = 0; index < eventsInfos.length; index++) {
    const eventsInfo = eventsInfos[index];
    const onchainData = await parseEventsInfo(eventsInfo);
    allOnChainData.push(onchainData);
  }
  return allOnChainData;
}

export async function extractRoyalties(fillEvent: es.fills.Event) {
  const royaltyFeeBreakdown: Royalty[] = [];
  const marketplaceFeeBreakdown: Royalty[] = [];
  const possibleMissingRoyalties: Royalty[] = [];

  const { txHash } = fillEvent.baseEventParams;

  const { tokenId, contract, price } = fillEvent;
  const txTrace = await utils.fetchTransactionTrace(txHash);
  if (!txTrace) {
    return null;
  }

  const events = await getEnhancedEventFromTransaction(txHash);
  const allOnChainData = await parseEnhancedEventToOnChainData(events);

  let fillEvents: es.fills.Event[] = [];

  for (let index = 0; index < allOnChainData.length; index++) {
    const data = allOnChainData[index];
    const allEvents = concat(data.fillEvents, data.fillEventsPartial, data.fillEventsOnChain);
    fillEvents = [...fillEvents, ...allEvents];
  }

  const collectionFills = fillEvents?.filter((_) => _.contract === contract) || [];
  const protocolFillEvents = fillEvents?.filter((_) => _.orderKind === "seaport") || [];

  const protocolRelatedAmount = protocolFillEvents
    ? protocolFillEvents.reduce((total, item) => {
        return total.add(bn(item.price));
      }, bn(0))
    : bn(0);

  const collectionRelatedAmount = collectionFills.reduce((total, item) => {
    return total.add(bn(item.price));
  }, bn(0));

  const state = parseCallTrace(txTrace.calls);
  const royalties = await getDefaultRoyalties(contract, tokenId);

  const openSeaFeeRecipients = [
    "0x5b3256965e7c3cf26e11fcaf296dfc8807c01073",
    "0x8de9c5a032463c561423387a9648c5c7bcc5bc90",
    "0x0000a26b00c1f0df003000390027140000faa719",
  ];

  const balanceChangeWithBps = [];
  const royaltyRecipients: string[] = royalties.map((_) => _.recipient);
  const threshold = 1000;
  let sameCollectionSales = 0;
  let totalTransfers = 0;

  // Tracking same collection sales
  for (const address in state) {
    const { tokenBalanceState } = state[address];
    for (const stateId in tokenBalanceState) {
      const changeValue = tokenBalanceState[stateId];
      const nftTransfer = stateId.startsWith(`erc721:`) || stateId.startsWith(`erc1155:`);
      const isNFTState =
        stateId.startsWith(`erc721:${contract}`) || stateId.startsWith(`erc1155:${contract}`);
      const notIncrease = changeValue.startsWith("-");
      if (isNFTState && !notIncrease) {
        sameCollectionSales++;
      }
      if (nftTransfer && !notIncrease) {
        totalTransfers++;
      }
    }
  }

  for (const address in state) {
    const { tokenBalanceState } = state[address];
    const weth = "erc20:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const native = "native:0x0000000000000000000000000000000000000000";
    const balanceChange = tokenBalanceState[native] || tokenBalanceState[weth];

    // Receive ETH
    if (balanceChange && !balanceChange.startsWith("-")) {
      const bpsInPrice = bn(balanceChange).mul(10000).div(bn(price));
      const curRoyalties = {
        recipient: address,
        bps: bpsInPrice.toNumber(),
      };

      if (openSeaFeeRecipients.includes(address)) {
        // Need to know how many seaport sales in the same tx
        curRoyalties.bps = bn(balanceChange).mul(10000).div(protocolRelatedAmount).toNumber();
        marketplaceFeeBreakdown.push(curRoyalties);
      } else if (royaltyRecipients.includes(address)) {
        // For multiple same collection sales in one tx
        curRoyalties.bps = bn(balanceChange).mul(10000).div(collectionRelatedAmount).toNumber();
        royaltyFeeBreakdown.push(curRoyalties);
      } else if (bpsInPrice.lt(threshold)) {
        possibleMissingRoyalties.push(curRoyalties);
      }

      balanceChangeWithBps.push({
        recipient: address,
        balanceChange,
        bps: bpsInPrice.toString(),
      });
    }
  }

  const getTotalRoyaltyBps = (royalties?: Royalty[]) =>
    (royalties || []).map(({ bps }) => bps).reduce((a, b) => a + b, 0);

  const paidFullRoyalty = royaltyFeeBreakdown.length === royaltyRecipients.length;

  const result = {
    txHash,
    sale: {
      tokenId,
      contract,
      price: formatEther(price),
    },
    totalTransfers,
    royaltyFeeBps: getTotalRoyaltyBps(royaltyFeeBreakdown),
    marketplaceFeeBps: getTotalRoyaltyBps(marketplaceFeeBreakdown),
    royaltyFeeBreakdown,
    marketplaceFeeBreakdown,
    sameCollectionSales,
    paidFullRoyalty,
  };

  return result;
}
