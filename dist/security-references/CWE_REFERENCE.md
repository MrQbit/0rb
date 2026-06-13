# CWE Reference Table

Common Weakness Enumeration mappings for security findings. Assign the most specific CWE to each finding.

## Injection

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| SQL Injection | CWE-89 | Improper neutralization of special elements in SQL commands |
| Command Injection | CWE-78 | Improper neutralization of special elements in OS commands |
| Code Injection | CWE-94 | Improper control of generation of code |
| LDAP Injection | CWE-90 | Improper neutralization of special elements in LDAP query |
| XPath Injection | CWE-643 | Improper neutralization of data within XPath expressions |
| Expression Language Injection | CWE-917 | Improper neutralization of special elements in expression language |

## Cross-Site Scripting

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| XSS (Reflected) | CWE-79 | Improper neutralization of input during web page generation |
| XSS (Stored) | CWE-79 | Same CWE, stored variant |
| XSS (DOM-based) | CWE-79 | Same CWE, DOM variant |

## Authentication & Authorization

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| Missing Authentication | CWE-306 | Missing authentication for critical function |
| Missing Authorization | CWE-862 | Missing authorization |
| Incorrect Authorization | CWE-863 | Incorrect authorization |
| Broken Access Control (IDOR) | CWE-639 | Authorization bypass through user-controlled key |
| Hardcoded Credentials | CWE-798 | Use of hard-coded credentials |
| Weak Password Requirements | CWE-521 | Weak password requirements |
| Insufficient Session Expiration | CWE-613 | Insufficient session expiration |

## Data Exposure

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| Sensitive Data Exposure | CWE-200 | Exposure of sensitive information |
| Cleartext Transmission | CWE-319 | Cleartext transmission of sensitive information |
| Cleartext Storage | CWE-312 | Cleartext storage of sensitive information |
| Error Message Info Leak | CWE-209 | Generation of error message containing sensitive information |

## Input Handling

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| Path Traversal | CWE-22 | Improper limitation of a pathname to a restricted directory |
| Mass Assignment | CWE-915 | Improperly controlled modification of dynamically-determined object attributes |
| Open Redirect | CWE-601 | URL redirection to untrusted site |
| SSRF | CWE-918 | Server-side request forgery |
| XXE | CWE-611 | Improper restriction of XML external entity reference |
| Insecure Deserialization | CWE-502 | Deserialization of untrusted data |
| Unrestricted File Upload | CWE-434 | Unrestricted upload of file with dangerous type |

## Cryptography

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| Weak Crypto Algorithm | CWE-327 | Use of a broken or risky cryptographic algorithm |
| Insufficient Key Size | CWE-326 | Inadequate encryption strength |
| Missing Encryption | CWE-311 | Missing encryption of sensitive data |
| Weak PRNG | CWE-338 | Use of cryptographically weak PRNG |

## Resource Management

| Vulnerability | CWE | Description |
|--------------|-----|-------------|
| Uncontrolled Resource Consumption | CWE-400 | Uncontrolled resource consumption |
| ReDoS | CWE-1333 | Inefficient regular expression complexity |
| Race Condition | CWE-362 | Concurrent execution using shared resource with improper synchronization |
