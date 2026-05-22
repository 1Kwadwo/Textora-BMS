function createWallet(initialBalance = 0) {
  let balance =
    Number(initialBalance)

  function getBalance() {
    return balance
  }

  function canDebit(amount) {
    return balance >= Number(amount)
  }

  function debit(amount) {
    const debitAmount =
      Number(amount)

    if (!Number.isFinite(debitAmount) || debitAmount < 0) {
      throw new Error('Wallet debit amount must be a positive number.')
    }

    if (!canDebit(debitAmount)) {
      return {
        ok: false,
        balance
      }
    }

    balance =
      Number((balance - debitAmount).toFixed(2))

    return {
      ok: true,
      balance
    }
  }

  return {
    canDebit,
    debit,
    getBalance
  }
}

module.exports = {
  createWallet
}
