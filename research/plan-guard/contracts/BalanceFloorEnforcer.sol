// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IERC20BalanceOf {
    function balanceOf(address account) external view returns (uint256);
}

/// @title BalanceFloorEnforcer
/// @notice Caveat enforcer for MetaMask's delegation framework (v1.3.0 hook signatures). After the redemption's
/// executions, the delegator must hold at least `floor` of `token` (address(0) means native ETH).
/// @dev Terms: token (20 bytes) | floor (32 bytes). Unlike ERC20BalanceChangeEnforcer, the bound is absolute. That
/// lets a plan signed before earlier steps run say "keep at least R" or "end with at least G", whatever those
/// steps actually produced. The check runs in afterAllHook, so intermediate balances inside a batch don't matter.
contract BalanceFloorEnforcer {
    function getTermsInfo(bytes calldata _terms) public pure returns (address token_, uint256 floor_) {
        require(_terms.length == 52, "BalanceFloorEnforcer:invalid-terms-length");
        token_ = address(bytes20(_terms[0:20]));
        floor_ = uint256(bytes32(_terms[20:52]));
    }

    function beforeAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external { }

    function beforeHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external { }

    function afterHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external { }

    function afterAllHook(
        bytes calldata _terms,
        bytes calldata,
        bytes32,
        bytes calldata,
        bytes32,
        address _delegator,
        address
    )
        external
        view
    {
        (address token_, uint256 floor_) = getTermsInfo(_terms);
        uint256 balance_ = token_ == address(0) ? _delegator.balance : IERC20BalanceOf(token_).balanceOf(_delegator);
        require(balance_ >= floor_, "BalanceFloorEnforcer:below-floor");
    }
}
