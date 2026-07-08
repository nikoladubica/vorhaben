// Maps a flat auth error code to a human, form-level message.
export function authErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_credentials':
      return 'Email or password is incorrect';
    case 'email_taken':
      return 'That email is already registered';
    case 'password_too_short':
      return 'Password must be at least 8 characters';
    case 'invalid_email':
      return 'Enter a valid email';
    case 'invalid_base_currency':
      return 'Choose a valid base currency';
    default:
      return 'Something went wrong. Please try again.';
  }
}
