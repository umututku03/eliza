// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title PlanStepEnforcer
/// @notice Caveat enforcer for MetaMask's delegation framework (v1.3.0 hook signatures). It binds a delegation to
/// one step of a plan the delegator approved up front. The step can run only after its prerequisite steps, and
/// it can succeed only once.
/// @dev Terms: planId (32 bytes) | step index (1 byte, < 256) | prerequisite bitmask (32 bytes).
/// The step is marked complete in beforeHook. A redemption is atomic, so a reverted execution rolls the mark back
/// and the step stays open for a retry. Try-mode execution is refused, because there a failed call would not
/// revert and the step would be marked complete without any effect. State is keyed by the calling delegation
/// manager, as in LimitedCallsEnforcer, so direct calls to the hooks only write to the caller's own namespace.
contract PlanStepEnforcer {
    /// @dev delegation manager => delegator => planId => bitmask of completed steps
    mapping(address => mapping(address => mapping(bytes32 => uint256))) public completed;

    event StepCompleted(
        address indexed delegationManager, address indexed delegator, bytes32 indexed planId, uint8 step, bytes32 delegationHash
    );

    function getTermsInfo(bytes calldata _terms) public pure returns (bytes32 planId_, uint8 step_, uint256 prerequisites_) {
        require(_terms.length == 65, "PlanStepEnforcer:invalid-terms-length");
        planId_ = bytes32(_terms[0:32]);
        step_ = uint8(_terms[32]);
        prerequisites_ = uint256(bytes32(_terms[33:65]));
        require(prerequisites_ & (uint256(1) << step_) == 0, "PlanStepEnforcer:self-prerequisite");
    }

    function beforeAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external { }

    function beforeHook(
        bytes calldata _terms,
        bytes calldata,
        bytes32 _mode,
        bytes calldata,
        bytes32 _delegationHash,
        address _delegator,
        address
    )
        external
    {
        // ModeCode layout: callType (1 byte) | execType (1 byte) | ...; execType 0x00 is the reverting default.
        require(_mode[1] == 0x00, "PlanStepEnforcer:invalid-execution-type");
        (bytes32 planId_, uint8 step_, uint256 prerequisites_) = getTermsInfo(_terms);
        uint256 done_ = completed[msg.sender][_delegator][planId_];
        uint256 bit_ = uint256(1) << step_;
        require(done_ & bit_ == 0, "PlanStepEnforcer:step-already-completed");
        require(done_ & prerequisites_ == prerequisites_, "PlanStepEnforcer:prerequisites-incomplete");
        completed[msg.sender][_delegator][planId_] = done_ | bit_;
        emit StepCompleted(msg.sender, _delegator, planId_, step_, _delegationHash);
    }

    function afterHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external { }

    function afterAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external { }
}
