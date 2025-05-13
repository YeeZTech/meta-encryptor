import axios from 'axios'

export const request = axios.create({
  withCredentials: false,
  timeout: 1000 * 60 * 10
})