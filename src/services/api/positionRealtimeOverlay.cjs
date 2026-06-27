const { getOpenPositionSnapshotsForWallet } = require("../onchain/onchainOpenPositions.cjs");
const { mergePosition } = require("./hybridOpenPositions.cjs");

async function overlayPositionDetailWithRealtime(positionDetail, config = {}) {
  if (!positionDetail || !positionDetail.owner || !positionDetail.position) {
    return positionDetail;
  }

  const livePayload = await getOpenPositionSnapshotsForWallet(positionDetail.owner, config);
  const livePosition = (livePayload.data.positions || []).find(
    (position) => position.position === positionDetail.position,
  );
  if (!livePosition) return positionDetail;

  return mergePosition(positionDetail, livePosition);
}

module.exports = {
  overlayPositionDetailWithRealtime,
};
